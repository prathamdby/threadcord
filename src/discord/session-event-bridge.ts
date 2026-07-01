import type {
  AgentEventKind,
  AgentEventRecord,
  ConversationLog,
  ConversationLogEventInput,
} from "../agentturn/conversation-log.js";
import {
  DEFAULT_AGENT_MAX_TOOL_FAILURES,
  DEFAULT_AGENT_MAX_VALIDATION_FAILURES,
  resolveAgentMaxToolFailures,
  resolveAgentMaxValidationFailures,
} from "./agent-guardrails.js";
import {
  clearToolFailureGuard,
  markToolGuardFailureDelivered,
  maybeAbortOnToolFailures,
  noteAgentTurnBoundary,
  shouldSkipObserveFailureDelivery,
  type ToolResultEvent,
} from "./tool-failure-guard.js";
import { posix } from "node:path";
import { isThreadcordInstance } from "../ids.js";
import { getRuntimeConfig } from "../config.js";
import { redact } from "../util/redact.js";
import { checkoutPathForTask } from "../task/turn-context.js";
import { validateFinalOutput } from "./final-output-validator.js";
import {
  BridgeProgressLine,
  ObserveBridgeCallbacks,
  ObserveBridgeState,
  flushProgressMessage,
  renderProgressLine,
  resolveProgressStream,
  withInstanceEventLock,
} from "./observe-bridge.js";
import {
  formatToolFailureLine,
  formatToolLine,
  isTerminalBlock,
} from "./tool-format.js";
import { setPendingUserTurnMessage } from "./user-turn-message.js";

/**
 * AgentOS session event taxonomy consumed by the bridge. These events are
 * produced by the AgentOS runtime during a prompt and are mapped to the
 * existing Discord progress bridge inputs.
 */
export type AgentOsSessionEvent =
  | { type: "turn_start"; instanceId: string; turnId?: string; attemptId?: string }
  | { type: "text_delta"; instanceId: string; delta: string; turnId?: string; attemptId?: string }
  | { type: "agent_message"; instanceId: string; content: string; turnId?: string; attemptId?: string }
  | {
      type: "tool_start";
      instanceId: string;
      toolName: string;
      args: unknown;
      toolCallId: string;
      turnId?: string;
      attemptId?: string;
    }
  | {
      type: "tool_result";
      instanceId: string;
      toolName: string;
      toolCallId: string;
      isError: boolean;
      result: unknown;
      turnId?: string;
      attemptId?: string;
    }
  | { type: "permission_failure"; instanceId: string; summary: string; turnId?: string; attemptId?: string }
  | { type: "final_output"; instanceId: string; content: string; turnId?: string; attemptId?: string }
  | { type: "turn_completed"; instanceId: string; turnId?: string; attemptId?: string }
  | { type: "turn_failed"; instanceId: string; summary: string; turnId?: string; attemptId?: string }
  | { type: "turn_cancelled"; instanceId: string; turnId?: string; attemptId?: string }
  | { type: "environment_issue"; instanceId: string; summary: string; turnId?: string; attemptId?: string }
  | { type: "unknown"; instanceId: string; rawType: string; payload?: unknown; turnId?: string; attemptId?: string };

interface PendingToolStart {
  toolName: string;
  args: unknown;
}

export function newSessionEventBridgeState(): ObserveBridgeState {
  return {
    renderState: new Map(),
    timers: new Map(),
    instanceChains: new Map(),
    pendingToolStarts: new Map(),
  };
}

export interface SessionEventBridge {
  /**
   * Process a single AgentOS session event: translate it into Discord
   * progress bridge inputs, log it to the ConversationLog, and invoke lifecycle
   * callbacks.
   */
  handleEvent(event: AgentOsSessionEvent): Promise<void>;

  /**
   * Rebuild the Discord live status message from canonical events after a retry
   * superseded the previous attempt's output. This clears the in-memory render
   * state and re-renders the progress bubble from the non-superseded event
   * projection without re-persisting the events.
   */
  rebuildStatus(instanceId: string, events: AgentEventRecord[]): Promise<void>;
}

export interface SessionEventBridgeDependencies {
  callbacks: ObserveBridgeCallbacks;
  conversationLog: ConversationLog;
}

export class SessionEventBridgeImpl implements SessionEventBridge {
  private readonly state: ObserveBridgeState;

  constructor(private readonly deps: SessionEventBridgeDependencies) {
    this.state = newSessionEventBridgeState();
  }

  async handleEvent(event: AgentOsSessionEvent): Promise<void> {
    const instanceId = event.instanceId;
    if (!instanceId) return;

    await withInstanceEventLock(instanceId, this.state, async () => {
      await this.persistEvent(event);

      const isTaskInstance = isThreadcordInstance(instanceId);
      const isSetupInstance = instanceId.startsWith("setup:");
      const maxFailures = resolveMaxFailuresForSessionBridge();

      const toolFailureTrip =
        isTaskInstance || isSetupInstance
          ? await this.evaluateToolFailureGuard(event, instanceId, maxFailures)
          : undefined;
      if (toolFailureTrip && (isTaskInstance || isSetupInstance)) {
        await this.deps.callbacks.onAgentFailure(instanceId, toolFailureTrip);
        markToolGuardFailureDelivered(instanceId);
      }

      if (event.type === "turn_start") {
        noteAgentTurnBoundary(instanceId);
        await this.sendMilestone(instanceId, "Model turn started");
        return;
      }

      if (event.type === "turn_failed" || event.type === "permission_failure") {
        clearToolFailureGuard(instanceId);
        clearPendingToolStartsForInstance(this.state, instanceId);
        if (!shouldSkipObserveFailureDelivery(instanceId)) {
          await this.deps.callbacks.onAgentFailure(
            instanceId,
            redact(event.summary),
          );
        }
        return;
      }

      if (event.type === "turn_cancelled") {
        clearToolFailureGuard(instanceId);
        clearPendingToolStartsForInstance(this.state, instanceId);
        await this.sendMilestone(instanceId, "Agent turn cancelled");
        await this.deps.callbacks.onAgentEnd(instanceId);
        return;
      }

      if (event.type === "turn_completed") {
        clearToolFailureGuard(instanceId);
        clearPendingToolStartsForInstance(this.state, instanceId);
        await this.sendMilestone(instanceId, "Agent turn completed");
        await this.deps.callbacks.onAgentEnd(instanceId);
        return;
      }

      if (event.type === "final_output") {
        const validationError = validateFinalOutput(event.content);
        if (validationError) {
          await this.deps.callbacks.onAgentFailure(instanceId, validationError);
          return;
        }
        setPendingUserTurnMessage(instanceId, event.content);
        return;
      }

      if (event.type === "environment_issue") {
        await this.sendMilestone(
          instanceId,
          `Environment issue: ${redact(event.summary)}`,
        );
        return;
      }

      if (!isTaskInstance && !isSetupInstance) return;

      const summary = await this.eventSummary(event, instanceId);
      if (!summary) return;

      await renderProgressLine(
        instanceId,
        summary,
        this.deps.callbacks,
        this.state,
      );
    });
  }

  async rebuildStatus(
    instanceId: string,
    events: AgentEventRecord[],
  ): Promise<void> {
    if (!instanceId) return;
    await withInstanceEventLock(instanceId, this.state, async () => {
      this.state.renderState.delete(instanceId);
      clearPendingToolStartsForInstance(this.state, instanceId);

      for (const event of events) {
        await this.renderCanonicalEvent(event, instanceId);
      }

      const current = this.state.renderState.get(instanceId);
      if (current && current.lines.length > 0) {
        const resolved = await resolveProgressStream(
          instanceId,
          this.deps.callbacks,
        );
        await flushProgressMessage(
          resolved.target,
          current,
          this.deps.callbacks.publisher,
        );
      }

      const timer = this.state.timers.get(instanceId);
      if (timer) {
        clearTimeout(timer);
        this.state.timers.delete(instanceId);
      }
    });
  }

  private async renderCanonicalEvent(
    record: AgentEventRecord,
    instanceId: string,
  ): Promise<void> {
    const payload = record.payload as Record<string, unknown> | null;
    switch (record.event_kind) {
      case "text_delta": {
        const delta = payload?.delta;
        if (typeof delta !== "string") return;
        await renderProgressLine(
          instanceId,
          { line: redact(delta), terminal: false },
          this.deps.callbacks,
          this.state,
        );
        return;
      }
      case "agent_message": {
        const content = payload?.content;
        if (typeof content !== "string") return;
        await renderProgressLine(
          instanceId,
          { line: redact(content), terminal: false },
          this.deps.callbacks,
          this.state,
        );
        return;
      }
      case "tool_start": {
        const toolName = payload?.toolName;
        const args = payload?.args;
        const toolCallId = payload?.toolCallId;
        if (typeof toolName !== "string" || typeof toolCallId !== "string") {
          return;
        }
        const key = pendingToolKey(instanceId, toolCallId);
        this.state.pendingToolStarts.set(key, { toolName, args });
        const repoRoot = await this.resolveRepoRoot(instanceId);
        const line = formatToolLine(
          toolName,
          args,
          repoRoot !== undefined ? { repoRoot } : undefined,
        );
        await renderProgressLine(
          instanceId,
          { line, terminal: isTerminalBlock(toolName, args) },
          this.deps.callbacks,
          this.state,
        );
        return;
      }
      case "tool_result":
      case "tool_failure": {
        const toolName = payload?.toolName;
        const toolCallId = payload?.toolCallId;
        if (typeof toolName !== "string" || typeof toolCallId !== "string") {
          return;
        }
        const isError = record.event_kind === "tool_failure";
        const key = pendingToolKey(instanceId, toolCallId);
        const pending = this.state.pendingToolStarts.get(key);
        if (!isError) {
          this.state.pendingToolStarts.delete(key);
          return;
        }
        const repoRoot = await this.resolveRepoRoot(instanceId);
        const line = formatToolFailureLine(
          toolName,
          pending?.args,
          repoRoot !== undefined ? { repoRoot } : undefined,
        );
        const terminal = isTerminalBlock(toolName, pending?.args);
        this.state.pendingToolStarts.delete(key);
        await renderProgressLine(
          instanceId,
          { line, terminal },
          this.deps.callbacks,
          this.state,
        );
        return;
      }
      default:
        return;
    }
  }

  private async persistEvent(event: AgentOsSessionEvent): Promise<void> {
    const logInput = toConversationLogEvent(event);
    if (!logInput) return;
    await this.deps.conversationLog.append(logInput);
  }

  private async evaluateToolFailureGuard(
    event: AgentOsSessionEvent,
    instanceId: string,
    maxFailures: { maxFailures: number; maxValidationFailures: number },
  ): Promise<string | undefined> {
    if (event.type === "tool_result" && event.isError) {
      const toolEvent: ToolResultEvent = {
        type: "tool",
        toolName: event.toolName,
        isError: true,
        result: event.result,
      };
      return maybeAbortOnToolFailures(
        toolEvent,
        instanceId,
        maxFailures.maxFailures,
        maxFailures.maxValidationFailures,
      );
    }
    if (event.type === "permission_failure") {
      const toolEvent: ToolResultEvent = {
        type: "tool",
        toolName: "permission",
        isError: true,
        result: event.summary,
      };
      return maybeAbortOnToolFailures(
        toolEvent,
        instanceId,
        maxFailures.maxFailures,
        maxFailures.maxValidationFailures,
      );
    }
    return undefined;
  }

  private async sendMilestone(
    instanceId: string,
    content: string,
  ): Promise<void> {
    const stream = await resolveProgressStream(instanceId, this.deps.callbacks);
    if (!stream.target) return;
    try {
      await this.deps.callbacks.publisher.send(
        stream.target.threadId,
        redact(content),
      );
    } catch (error) {
      console.error(
        `[threadcord] milestone post failed for ${instanceId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async eventSummary(
    event: AgentOsSessionEvent,
    instanceId: string,
  ): Promise<BridgeProgressLine | undefined> {
    switch (event.type) {
      case "text_delta":
        return { line: redact(event.delta), terminal: false };
      case "agent_message":
        return { line: redact(event.content), terminal: false };
      case "tool_start": {
        const key = pendingToolKey(instanceId, event.toolCallId);
        this.state.pendingToolStarts.set(key, {
          toolName: event.toolName,
          args: event.args,
        });
        const repoRoot = await this.resolveRepoRoot(instanceId);
        const line = formatToolLine(
          event.toolName,
          event.args,
          repoRoot !== undefined ? { repoRoot } : undefined,
        );
        return { line, terminal: isTerminalBlock(event.toolName, event.args) };
      }
      case "tool_result": {
        const key = pendingToolKey(instanceId, event.toolCallId);
        const pending = this.state.pendingToolStarts.get(key);
        if (!event.isError) {
          this.state.pendingToolStarts.delete(key);
          return undefined;
        }
        console.error(
          `[threadcord] tool call error on ${instanceId}`,
          event.toolName,
          redact(String(event.result)),
        );
        const repoRoot = await this.resolveRepoRoot(instanceId);
        const line = formatToolFailureLine(
          event.toolName,
          pending?.args,
          repoRoot !== undefined ? { repoRoot } : undefined,
        );
        const terminal = isTerminalBlock(event.toolName, pending?.args);
        this.state.pendingToolStarts.delete(key);
        return { line, terminal };
      }
      case "unknown": {
        console.error(
          `[threadcord] unknown session event on ${instanceId}:`,
          event.rawType,
          redactPayloadForLog(event.payload),
        );
        return { line: "Agent activity...", terminal: false };
      }
      default:
        return undefined;
    }
  }

  private async resolveRepoRoot(instanceId: string): Promise<string | undefined> {
    if (isThreadcordInstance(instanceId)) {
      const task = await this.deps.callbacks.store.getByInstanceId(instanceId);
      if (!task) return undefined;
      return checkoutPathForTask(task);
    }
    if (instanceId.startsWith("setup:") && this.deps.callbacks.setupStore) {
      const run = await this.deps.callbacks.setupStore.getRunByInstanceId(instanceId);
      if (!run) return undefined;
      return posix.join(run.workspacePath, posix.basename(run.repo));
    }
    return undefined;
  }
}

function pendingToolKey(instanceId: string, toolCallId: string): string {
  return `${instanceId}:${toolCallId}`;
}

function clearPendingToolStartsForInstance(
  state: ObserveBridgeState,
  instanceId: string,
): void {
  const prefix = `${instanceId}:`;
  for (const key of state.pendingToolStarts.keys()) {
    if (key.startsWith(prefix)) {
      state.pendingToolStarts.delete(key);
    }
  }
}

function toConversationLogEvent(
  event: AgentOsSessionEvent,
): ConversationLogEventInput | undefined {
  const base = {
    session_id: event.instanceId,
    turn_id: event.turnId ?? event.instanceId,
    attempt_id: event.attemptId ?? event.instanceId,
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
        payload: {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          result: event.result,
        },
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

function resolveMaxFailuresForSessionBridge(): {
  maxFailures: number;
  maxValidationFailures: number;
} {
  try {
    const c = getRuntimeConfig();
    return {
      maxFailures: resolveAgentMaxToolFailures(c),
      maxValidationFailures: resolveAgentMaxValidationFailures(c),
    };
  } catch {
    return {
      maxFailures: DEFAULT_AGENT_MAX_TOOL_FAILURES,
      maxValidationFailures: DEFAULT_AGENT_MAX_VALIDATION_FAILURES,
    };
  }
}

function redactPayloadForLog(payload: unknown): unknown {
  if (typeof payload === "string") return redact(payload);
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(redactPayloadForLog);
  const record = payload as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    redacted[key] = redactPayloadForLog(record[key]);
  }
  return redacted;
}

export function registerSessionEventBridge(
  args: ObserveBridgeCallbacks,
  conversationLog: ConversationLog,
): SessionEventBridge {
  return new SessionEventBridgeImpl({ callbacks: args, conversationLog });
}
