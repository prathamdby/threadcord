import { randomUUID } from "node:crypto";
import type {
  AgentTurn,
  AgentTurnInput,
  TerminalOutcome,
  TurnEvent,
} from "./types.js";

export interface FakeAgentTurnOptions {
  /** Maximum number of accepted (non-terminal) turns at a time. */
  maxConcurrency?: number;
  /** If true (default), resumeAfterRestart notifies interrupted threads. */
  enableRestartNotifications?: boolean;
  /** Called each time a new turn is accepted and started. */
  onPrompt?: (input: AgentTurnInput) => void;
}

interface ActiveTurn {
  input: AgentTurnInput;
  turnId: string;
  attemptId: string;
  terminal: boolean;
  terminalOutcome?: TerminalOutcome;
  pendingCancel: boolean;
}

export class FakeAgentTurn implements AgentTurn {
  readonly prompted: AgentTurnInput[] = [];
  readonly rejected: { input: AgentTurnInput; reason: string }[] = [];
  readonly events: TurnEvent[] = [];
  readonly restartedNotices: {
    instanceId: string;
    threadId: string;
    content: string;
  }[] = [];

  private readonly handlers = new Set<(event: TurnEvent) => void>();
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly idempotencyKeys = new Set<string>();
  private readonly maxConcurrency: number;
  private readonly enableRestartNotifications: boolean;
  private readonly onPrompt: ((input: AgentTurnInput) => void) | undefined;
  private nextBlock:
    | { resolve: () => void; reject: (err: Error) => void }
    | undefined;
  private blockNextFlag = false;
  private nextRejectionReason: string | undefined;

  constructor(options: FakeAgentTurnOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 1;
    this.enableRestartNotifications =
      options.enableRestartNotifications ?? true;
    this.onPrompt = options.onPrompt;
  }

  /** Reject the next prompt() call with a human-readable reason. */
  rejectNext(reason: string): void {
    this.nextRejectionReason = reason;
  }

  /**
   * Block the next prompt() call until release() is called.
   * Returns a release function.
   */
  blockNextPrompt(): { release: () => void } {
    this.blockNextFlag = true;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.nextBlock?.resolve();
      this.nextBlock = undefined;
    };
    return { release };
  }

  async prompt(
    input: AgentTurnInput,
  ): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    const validation = validateInput(input);
    if (!validation.ok) {
      this.rejected.push({ input, reason: validation.reason });
      return { accepted: false, reason: validation.reason };
    }

    if (this.nextRejectionReason) {
      const reason = this.nextRejectionReason;
      this.nextRejectionReason = undefined;
      this.rejected.push({ input, reason });
      return { accepted: false, reason };
    }

    const idempotencyKey = input.idempotencyKey ?? input.instanceId;
    if (this.idempotencyKeys.has(idempotencyKey)) {
      // Duplicate idempotency key: acknowledge the existing turn without
      // starting a new AgentOS session or attempt.
      return { accepted: true };
    }

    // A new turn for the same instance supersedes any prior active turn.
    // This mirrors the orchestrator invariant that a task has at most one
    // active turn at a time, and lets follow-up turns replace the previous
    // one without requiring an explicit terminal event in the fake.
    this.turns.delete(input.instanceId);

    // Admission check after removing any superseded same-instance turn so a
    // follow-up does not consume a slot held by the previous turn.
    if (this.activeCount() >= this.maxConcurrency) {
      const reason = "no concurrency slot available";
      this.rejected.push({ input, reason });
      return { accepted: false, reason };
    }

    // The idempotency key is only consumed once a turn has been successfully
    // admitted. Rejected prompts do not consume the key, so a later prompt
    // with the same key can still start a new turn.
    this.idempotencyKeys.add(idempotencyKey);

    const turnId = makeId("turn");
    const attemptId = makeId("attempt");
    const turn: ActiveTurn = {
      input,
      turnId,
      attemptId,
      terminal: false,
      pendingCancel: false,
    };
    this.turns.set(input.instanceId, turn);
    this.prompted.push(input);
    this.onPrompt?.(input);

    this.emit({
      type: "turnStarted",
      instanceId: input.instanceId,
      turnId,
      attemptId,
    });

    if (this.blockNextFlag) {
      this.blockNextFlag = false;
      await new Promise<void>((resolve, reject) => {
        this.nextBlock = { resolve, reject };
      });
      if (turn.pendingCancel) {
        this.emitTerminal(input.instanceId, "cancelled", "cancelled while starting");
        return { accepted: true };
      }
    }

    return { accepted: true };
  }

  async cancel(instanceId: string): Promise<void> {
    const turn = this.turns.get(instanceId);
    if (!turn || turn.terminal) return;

    if (this.nextBlock && this.isBlockedTurn(turn)) {
      // prompt() is still waiting for the block to be released; remember the
      // cancel so a terminal cancelled event is emitted as soon as it resumes.
      turn.pendingCancel = true;
      return;
    }

    this.emitTerminal(instanceId, "cancelled", "cancelled by operator");
  }

  onEvent(handler: (event: TurnEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async resumeAfterRestart(
    notify: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    for (const [instanceId, turn] of this.turns) {
      if (turn.terminal) continue;

      // Mark the turn as interrupted so no further events are emitted for it
      // and any concurrency slot it held is released for the next turn.
      turn.terminal = true;
      turn.terminalOutcome = "failed";

      const threadId = threadIdFromInstanceId(instanceId);
      if (!threadId || !this.enableRestartNotifications) continue;

      const content = "Resumed after restart. Ready for the next instruction.";
      this.restartedNotices.push({ instanceId, threadId, content });
      try {
        await notify(threadId, content);
      } catch (error) {
        console.error(
          `[threadcord] fake restart notification failed for ${instanceId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** Test helper: emit a progress event for a turn. */
  progress(instanceId: string, kind: string, payload: unknown): void {
    const turn = this.turns.get(instanceId);
    if (!turn || turn.terminal) return;
    this.emit({ type: "progress", instanceId, kind, payload });
  }

  /** Test helper: complete a turn with an optional summary. */
  complete(instanceId: string, summary?: string): void {
    this.emitTerminal(instanceId, "completed", summary);
  }

  /** Test helper: fail a turn with a summary. */
  fail(instanceId: string, summary: string): void {
    this.emitTerminal(instanceId, "failed", summary);
  }

  /** Test helper: abort a turn with a summary. */
  abort(instanceId: string, summary: string): void {
    this.emitTerminal(instanceId, "aborted", summary);
  }

  private activeCount(): number {
    return [...this.turns.values()].filter((t) => !t.terminal).length;
  }

  private isBlockedTurn(turn: ActiveTurn): boolean {
    return this.nextBlock !== undefined && !turn.terminal;
  }

  private emitTerminal(
    instanceId: string,
    outcome: TerminalOutcome,
    summary?: string,
  ): void {
    const turn = this.turns.get(instanceId);
    if (!turn || turn.terminal) return;
    turn.terminal = true;
    turn.terminalOutcome = outcome;
    const event: TurnEvent =
      summary === undefined
        ? { type: "terminal", instanceId, outcome }
        : { type: "terminal", instanceId, outcome, summary };
    this.emit(event);
  }

  private emit(event: TurnEvent): void {
    this.events.push(event);
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error(
          "[threadcord] fake AgentTurn event handler failed",
          error,
        );
      }
    }
  }
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

function threadIdFromInstanceId(instanceId: string): string | undefined {
  const prefix = "discord:thread:";
  if (instanceId.startsWith(prefix)) {
    return instanceId.slice(prefix.length);
  }
  return undefined;
}
