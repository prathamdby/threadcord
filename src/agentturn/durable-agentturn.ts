import { randomUUID } from "node:crypto";
import type { AgentOsSessionEvent } from "../discord/session-event-bridge.js";
import type {
  AgentEventKind,
  AgentEventRecord,
  ConversationLog,
  ConversationLogEventInput,
} from "./conversation-log.js";
import type { AgentSessionStore } from "./persistence.js";
import {
  TurnRunner,
  type RetryOptions,
  type TurnFailureClass,
} from "./turnrunner.js";
import type {
  AgentTurn,
  AgentTurnInput,
  AgentTurnRole,
  TerminalOutcome,
  TurnEvent,
} from "./types.js";
import { hashInstruction } from "./utils.js";

export interface DurableAgentTurnDependencies {
  /** The inner AgentTurn implementation that executes the actual agent prompt. */
  inner: AgentTurn;
  /** Durable turn attempts (leases, heartbeats, retries). */
  turnRunner: TurnRunner;
  /** Append-only conversation event log. */
  conversationLog: ConversationLog;
  /** Session and turn metadata store. */
  sessionStore: AgentSessionStore;
  /** Optional forwarder for detailed session events (e.g., to the SessionEventBridge). */
  onSessionEvent?: (event: AgentOsSessionEvent) => void;
  /** Optional callback to rebuild the Discord status projection from canonical events. */
  rebuildStatus?: (instanceId: string, events: AgentEventRecord[]) => Promise<void>;
  /** Optional callback that extracts a Discord thread id from an instance id. */
  getThreadId?: (instanceId: string) => string | undefined;
  /** Optional logger for errors. */
  logger?: {
    log(level: string, message: string, meta?: Record<string, unknown>): void;
  };
  /** Heartbeat timeout used to drive attempt heartbeats while a turn is active. */
  heartbeatTimeoutMs?: number;
}

interface ActiveDurableTurn {
  input: AgentTurnInput;
  turnId: string;
  attemptId: string;
  sessionId: string;
  innerTurnId: string | undefined;
  innerAttemptId: string | undefined;
  terminal: boolean;
}

const RESTART_NOTICE = "Resumed after restart. Ready for the next instruction.";

/**
 * DurableAgentTurn wraps an inner AgentTurn and adds Postgres-backed persistence
 * and restart resume. It is the composition point for the deep modules:
 * TurnRunner, ConversationLog, and the session/turn metadata store.
 *
 * - Every accepted turn creates a durable `agent_sessions`/`agent_turns` row and
 *   a `agent_turn_attempts` row via TurnRunner.
 * - Detailed AgentOS session events received via `onSessionEvent` are appended
 *   to the ConversationLog with the durable turn/attempt ids.
 * - Terminal events mark the attempt terminal in TurnRunner and update the turn
 *   row status.
 * - After a restart, expired attempts are reconciled and the transcript is
 *   rebuilt from canonical events so the next follow-up can resume coherently.
 */
export class DurableAgentTurn implements AgentTurn {
  private readonly handlers = new Set<(event: TurnEvent) => void>();
  private readonly turns = new Map<string, ActiveDurableTurn>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly deps: DurableAgentTurnDependencies;

  constructor(deps: DurableAgentTurnDependencies) {
    this.deps = deps;
    this.unsubscribeInner = this.deps.inner.onEvent((event) =>
      this.handleInnerEvent(event),
    );
  }

  private readonly unsubscribeInner: () => void;

  async prompt(
    input: AgentTurnInput,
  ): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    const validation = validateInput(input);
    if (!validation.ok) {
      return { accepted: false, reason: validation.reason };
    }

    const sessionId = input.instanceId;
    let session = await this.deps.sessionStore.getSession(sessionId);
    if (!session) {
      session = await this.deps.sessionStore.createSession({
        agent_instance_id: sessionId,
        task_id: null,
        setup_run_id: null,
        role: input.role,
        repo: input.repo,
        branch: input.baseBranch,
        workspace_path: input.workspacePath,
        agent_type: "pi",
        cwd: null,
        env_names: input.env ? Object.keys(input.env) : null,
        setup_profile_revision: input.setupProfileRevision,
        status: "active",
      });
    }

    const idempotencyKey = input.idempotencyKey ?? input.instanceId;
    const existing = await this.deps.sessionStore.findTurnByIdempotencyKey(
      sessionId,
      idempotencyKey,
    );
    if (existing) {
      // Duplicate idempotency key: acknowledge without starting a new turn.
      return { accepted: true };
    }

    const turnId = makeId("turn");
    const now = new Date();
    await this.deps.sessionStore.createTurn({
      turn_id: turnId,
      agent_instance_id: sessionId,
      discord_message_id: input.idempotencyKey ?? null,
      instruction_hash: hashInstruction(input.instruction),
      role: input.role,
      queued_at: now,
      started_at: null,
      terminal_at: null,
      status: "queued",
      active_attempt_id: null,
      idempotency_key: idempotencyKey,
    });

    const attempt = await this.deps.turnRunner.startAttempt(turnId);
    if (!attempt.accepted) {
      await this.deps.sessionStore.updateTurn(turnId, {
        status: "failed",
        terminal_at: now,
      });
      return { accepted: false, reason: attempt.reason };
    }

    this.startHeartbeat(sessionId, attempt.heartbeat);

    await this.deps.sessionStore.updateTurn(turnId, {
      status: "running",
      started_at: now,
      active_attempt_id: attempt.attemptId,
    });

    const transcript = await this.rebuildTranscript(sessionId);
    const inputWithTranscript: AgentTurnInput = {
      ...input,
      transcript,
    };

    const active: ActiveDurableTurn = {
      input: inputWithTranscript,
      turnId,
      attemptId: attempt.attemptId,
      sessionId,
      innerTurnId: undefined,
      innerAttemptId: undefined,
      terminal: false,
    };
    this.turns.set(sessionId, active);

    try {
      const result = await this.deps.inner.prompt(inputWithTranscript);
      if (!result.accepted) {
        this.stopHeartbeat(sessionId);
        this.turns.delete(sessionId);
        await this.deps.turnRunner.markTerminal(attempt.attemptId, "failed", result.reason);
        await this.deps.sessionStore.updateTurn(turnId, {
          status: "failed",
          terminal_at: new Date(),
          active_attempt_id: null,
        });
        return { accepted: false, reason: result.reason };
      }
    } catch (error) {
      this.stopHeartbeat(sessionId);
      this.turns.delete(sessionId);
      const summary = error instanceof Error ? error.message : String(error);
      await this.deps.turnRunner.markTerminal(attempt.attemptId, "failed", summary);
      await this.deps.sessionStore.updateTurn(turnId, {
        status: "failed",
        terminal_at: new Date(),
        active_attempt_id: null,
      });
      return { accepted: false, reason: summary };
    }

    this.emit({
      type: "turnStarted",
      instanceId: sessionId,
      turnId,
      attemptId: attempt.attemptId,
    });

    return { accepted: true };
  }

  async cancel(instanceId: string): Promise<void> {
    const turn = this.turns.get(instanceId);
    if (turn && !turn.terminal) {
      await this.deps.turnRunner.cancel(turn.turnId);
    }
    await this.deps.inner.cancel(instanceId);
  }

  /**
   * Retry a turn after a retryable failure. Delegates to TurnRunner for the
   * durable attempt policy and marks the superseded attempt's events in the
   * ConversationLog so stale partial output is excluded from the transcript.
   */
  async retryTurn(
    instanceId: string,
    failureClass: TurnFailureClass,
    options?: RetryOptions,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const turn = this.turns.get(instanceId);
    if (!turn || turn.terminal) {
      return { accepted: false, reason: "no active turn to retry" };
    }

    const result = await this.deps.turnRunner.retry(
      turn.turnId,
      failureClass,
      options,
    );
    if (!result.accepted) {
      return { accepted: false, reason: result.reason };
    }

    if (result.supersededAttemptId) {
      await this.deps.conversationLog.markSuperseded(
        result.supersededAttemptId,
      );
      const canonical = await this.deps.conversationLog.projectForDiscord(
        turn.sessionId,
      );
      await this.deps.rebuildStatus?.(turn.sessionId, canonical);
    }

    await this.deps.sessionStore.updateTurn(turn.turnId, {
      active_attempt_id: result.attemptId,
    });

    turn.attemptId = result.attemptId;
    return { accepted: true };
  }

  onEvent(handler: (event: TurnEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Process a detailed AgentOS session event. This should be wired to the inner
   * AgentTurn's session-event callback (e.g., AgentOsAgentTurn's onSessionEvent
   * option). The event is rewritten to use the durable turn/attempt ids and
   * appended to the ConversationLog before being forwarded to the optional
   * bridge callback.
   */
  async onSessionEvent(event: AgentOsSessionEvent): Promise<void> {
    const turn = this.turns.get(event.instanceId);
    if (!turn || turn.terminal) return;

    turn.innerTurnId = event.turnId ?? turn.innerTurnId;
    turn.innerAttemptId = event.attemptId ?? turn.innerAttemptId;

    const logInput = toConversationLogEvent(event, turn.turnId, turn.attemptId);
    if (logInput) {
      try {
        await this.deps.conversationLog.append(logInput);
      } catch (error) {
        this.logError("conversation-log-append-failed", event.instanceId, error);
      }
    }

    try {
      this.deps.onSessionEvent?.(event);
    } catch (error) {
      this.logError("session-event-forward-failed", event.instanceId, error);
    }
  }

  async resumeAfterRestart(
    notify: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    // Mark any active attempt whose heartbeat expired as interrupted.
    const interrupted = await this.deps.turnRunner.reconcileAfterRestart();

    for (const attempt of interrupted) {
      const turn = await this.deps.sessionStore.getTurn(attempt.turn_id);
      if (!turn) continue;
      await this.deps.sessionStore.updateTurn(turn.turn_id, {
        status: "failed",
        terminal_at: new Date(),
        active_attempt_id: null,
      });

      const threadId = this.deps.getThreadId?.(turn.agent_instance_id);
      if (threadId) {
        try {
          await notify(threadId, RESTART_NOTICE);
        } catch (error) {
          this.logError("restart-notification-failed", turn.agent_instance_id, error);
        }
      }
    }

    // Forward to the inner implementation so it can close any sessions it knows about.
    await this.deps.inner.resumeAfterRestart(notify);
  }

  private handleInnerEvent(event: TurnEvent): void {
    // The durable turn owns the canonical turnStarted event with its own
    // turn/attempt ids. Suppress the inner turnStarted to avoid duplicates.
    if (event.type === "turnStarted") return;

    void this.processInnerEvent(event);
  }

  private async processInnerEvent(event: TurnEvent): Promise<void> {
    const turn = this.turns.get(event.instanceId);
    if (!turn || turn.terminal) return;

    if (event.type === "terminal") {
      turn.terminal = true;
      this.stopHeartbeat(event.instanceId);
      try {
        await this.deps.turnRunner.markTerminal(
          turn.attemptId,
          event.outcome,
          event.summary,
        );
        await this.deps.sessionStore.updateTurn(turn.turnId, {
          status: event.outcome,
          terminal_at: new Date(),
          active_attempt_id: null,
        });
        // The session remains active so follow-up turns in the same task can
        // reuse it. The session is closed explicitly when the task itself
        // reaches a terminal status.
      } catch (error) {
        this.logError("terminal-state-update-failed", turn.sessionId, error);
      }
      this.turns.delete(event.instanceId);
    }

    this.emit(event);
  }

  private startHeartbeat(
    instanceId: string,
    heartbeat: () => Promise<void>,
  ): void {
    this.stopHeartbeat(instanceId);
    const timeoutMs = this.deps.heartbeatTimeoutMs ?? 120_000;
    const timer = setInterval(() => {
      void heartbeat().catch((error) => {
        this.logError("heartbeat-failed", instanceId, error);
      });
    }, timeoutMs / 3);
    timer.unref?.();
    this.heartbeatTimers.set(instanceId, timer);
  }

  private stopHeartbeat(instanceId: string): void {
    const timer = this.heartbeatTimers.get(instanceId);
    if (!timer) return;
    clearInterval(timer);
    this.heartbeatTimers.delete(instanceId);
  }

  private async rebuildTranscript(sessionId: string): Promise<string> {
    const events = await this.deps.conversationLog.rebuildTranscript(sessionId);
    return renderTranscript(events);
  }

  private emit(event: TurnEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        this.logError("durable-turn-event-handler-failed", event.instanceId, error);
      }
    }
  }

  private logError(
    message: string,
    instanceId: string | undefined,
    error: unknown,
  ): void {
    const summary = error instanceof Error ? error.message : String(error);
    this.deps.logger?.log("error", message, { instanceId, summary });
  }
}

export function createDurableAgentTurn(
  deps: DurableAgentTurnDependencies,
): DurableAgentTurn {
  return new DurableAgentTurn(deps);
}

function makeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function validateInput(
  input: AgentTurnInput,
): { ok: true } | { ok: false; reason: string } {
  const required: (keyof AgentTurnInput)[] = [
    "instanceId",
    "role",
    "instruction",
    "model",
    "workspacePath",
    "repo",
    "baseBranch",
  ];
  const missing = required.filter((key) => {
    const value = input[key];
    return value === undefined || value === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `missing required AgentTurn input fields: ${missing.join(", ")}`,
    };
  }
  return { ok: true };
}

function toConversationLogEvent(
  event: AgentOsSessionEvent,
  durableTurnId: string,
  durableAttemptId: string,
): ConversationLogEventInput | undefined {
  const base = {
    session_id: event.instanceId,
    turn_id: durableTurnId,
    attempt_id: durableAttemptId,
  };

  switch (event.type) {
    case "turn_start":
      return undefined;
    case "text_delta":
      return { ...base, event_kind: "text_delta", payload: { delta: event.delta } };
    case "agent_message":
      return { ...base, event_kind: "agent_message", payload: { content: event.content } };
    case "tool_start":
      return {
        ...base,
        event_kind: "tool_start",
        payload: { toolName: event.toolName, args: event.args, toolCallId: event.toolCallId },
      };
    case "tool_result":
      return {
        ...base,
        event_kind: event.isError ? "tool_failure" : "tool_result",
        payload: { toolName: event.toolName, toolCallId: event.toolCallId, result: event.result },
      };
    case "permission_failure":
      return { ...base, event_kind: "permission_failure", payload: { summary: event.summary } };
    case "final_output":
      return { ...base, event_kind: "final_output", payload: { content: event.content } };
    case "turn_completed":
      return { ...base, event_kind: "turn_completed", payload: {} };
    case "turn_failed":
      return { ...base, event_kind: "turn_failed", payload: { summary: event.summary } };
    case "turn_cancelled":
      return { ...base, event_kind: "turn_cancelled", payload: {} };
    case "environment_issue":
      return { ...base, event_kind: "environment_issue", payload: { summary: event.summary } };
    case "unknown":
      return { ...base, event_kind: "text_delta", payload: { rawType: event.rawType, payload: event.payload } };
    default:
      return undefined;
  }
}

function renderTranscript(events: AgentEventRecord[]): string {
  const parts: string[] = [];
  for (const event of events) {
    switch (event.event_kind) {
      case "text_delta":
      case "agent_message": {
        const payload = event.payload as { delta?: string; content?: string } | null;
        const text = payload?.delta ?? payload?.content ?? "";
        if (text) parts.push(text);
        break;
      }
      case "tool_start": {
        const payload = event.payload as { toolName?: string } | null;
        if (payload?.toolName) parts.push(`[tool: ${payload.toolName}]`);
        break;
      }
      case "final_output": {
        const payload = event.payload as { content?: string } | null;
        if (payload?.content) parts.push(`[final output] ${payload.content}`);
        break;
      }
      case "turn_completed":
      case "turn_failed":
      case "turn_cancelled":
      case "environment_issue": {
        const payload = event.payload as { summary?: string } | null;
        if (payload?.summary) parts.push(`[milestone: ${payload.summary}]`);
        break;
      }
      default:
        break;
    }
  }
  return parts.join("\n");
}
