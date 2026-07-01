import { randomUUID } from "node:crypto";
import type { TerminalOutcome } from "./types.js";

/**
 * Status of a turn attempt stored in `agent_turn_attempts`.
 *
 * Note: the contract stores cancelled/aborted outcomes as `interrupted` or
 * `failed` rows, with the precise outcome recorded in `terminal_reason`.
 */
export type AttemptStatus = "active" | "completed" | "failed" | "interrupted";

/**
 * Postgres row shape for `agent_turn_attempts`. This is the durable record
 * behind every turn attempt: lease owner, heartbeat, timeout, and terminal
 * status.
 */
export interface TurnAttemptRecord {
  attempt_id: string;
  turn_id: string;
  attempt_number: number;
  lease_owner: string;
  heartbeat_at: Date;
  started_at: Date;
  timeout_ms: number;
  retry_reason: string | null;
  terminal_reason: string | null;
  terminal_at: Date | null;
  status: AttemptStatus;
}

/**
 * Minimal store interface for `agent_turn_attempts`. The real implementation
 * is Postgres-backed; unit tests use an in-memory store.
 */
export interface TurnAttemptStore {
  insert(record: TurnAttemptRecord): Promise<void>;
  get(attemptId: string): Promise<TurnAttemptRecord | undefined>;
  listByTurnId(turnId: string): Promise<TurnAttemptRecord[]>;
  listActive(): Promise<TurnAttemptRecord[]>;
  update(
    attemptId: string,
    patch: Partial<TurnAttemptRecord>,
  ): Promise<TurnAttemptRecord | undefined>;
  updateIfActive(
    attemptId: string,
    patch: Partial<TurnAttemptRecord>,
  ): Promise<TurnAttemptRecord | undefined>;
}

export interface TurnRunnerConfig {
  /** Identifies the process or worker holding the lease. */
  leaseOwner: string;
  turnTimeoutMs: number;
  heartbeatTimeoutMs: number;
  setupInstallTimeoutMs: number;
  maxAttempts: number;
}

export interface Clock {
  now(): Date;
}

export type TurnFailureClass =
  | "provider_transient"
  | "sidecar_crash"
  | "host_shutdown"
  | "discord_projection"
  | "binding_error"
  | "validation_loop"
  | "timeout"
  | "unknown";

export interface RetryOptions {
  /** True if the failure happened after a tool/binding side effect occurred. */
  sideEffectOccurred?: boolean;
  /** Idempotency key for the side effect, required before retrying a binding. */
  idempotencyKey?: string;
  /** Human-readable reason stored in the retry attempt row. */
  reason?: string;
  /** Explicit previous attempt; otherwise the latest attempt for the turn is used. */
  previousAttemptId?: string;
}

export interface StartAttemptResult {
  accepted: true;
  attemptId: string;
  attemptNumber: number;
  timeoutMs: number;
  heartbeat: () => Promise<void>;
}

export interface StartAttemptRejected {
  accepted: false;
  reason: string;
}

export interface RetryResult {
  accepted: true;
  attemptId: string;
  attemptNumber: number;
  retryReason: string;
  /** Previous attempt whose events should be superseded, if any. */
  supersededAttemptId: string | undefined;
}

export interface RetryRejected {
  accepted: false;
  reason: string;
  terminalOutcome?: TerminalOutcome;
}

/**
 * TurnRunner is the durable execution engine behind AgentTurn. It owns turn
 * attempts as Postgres rows, leases, heartbeats, retry policy, idempotency,
 * terminal event durability, and cancellation races. It does not know
 * Discord formatting, AgentOS APIs, or setup profile details.
 */
export class TurnRunner {
  constructor(
    private readonly store: TurnAttemptStore,
    private readonly config: TurnRunnerConfig,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async startAttempt(
    turnId: string,
    options?: { timeoutMs?: number; setupInstall?: boolean },
  ): Promise<StartAttemptResult | StartAttemptRejected> {
    const attempts = await this.store.listByTurnId(turnId);
    const attemptNumber =
      attempts.reduce((max, attempt) => Math.max(max, attempt.attempt_number), 0) +
      1;
    const timeoutMs = options?.setupInstall
      ? this.config.setupInstallTimeoutMs
      : (options?.timeoutMs ?? this.config.turnTimeoutMs);
    const now = this.clock.now();

    const record: TurnAttemptRecord = {
      attempt_id: makeAttemptId(),
      turn_id: turnId,
      attempt_number: attemptNumber,
      lease_owner: this.config.leaseOwner,
      heartbeat_at: now,
      started_at: now,
      timeout_ms: timeoutMs,
      retry_reason: null,
      terminal_reason: null,
      terminal_at: null,
      status: "active",
    };

    await this.store.insert(record);

    return {
      accepted: true,
      attemptId: record.attempt_id,
      attemptNumber,
      timeoutMs,
      heartbeat: () => this.heartbeat(record.attempt_id),
    };
  }

  async heartbeat(attemptId: string): Promise<void> {
    const attempt = await this.store.get(attemptId);
    if (!attempt || attempt.status !== "active") return;
    await this.store.update(attemptId, { heartbeat_at: this.clock.now() });
  }

  /**
   * Idempotently mark an attempt as terminal. The first terminal wins;
   * subsequent calls return the already-recorded outcome.
   */
  async markTerminal(
    attemptId: string,
    outcome: TerminalOutcome,
    reason?: string,
  ): Promise<TerminalOutcome | undefined> {
    const attempt = await this.store.get(attemptId);
    if (!attempt) return undefined;

    if (attempt.status !== "active") {
      return this.outcomeFromStatus(attempt.status, attempt.terminal_reason);
    }

    const status = terminalStatusForOutcome(outcome);
    const terminalReason = reason ?? outcome;
    const updated = await this.store.updateIfActive(attemptId, {
      status,
      terminal_at: this.clock.now(),
      terminal_reason: terminalReason,
    });
    if (!updated) {
      const current = await this.store.get(attemptId);
      if (!current) return undefined;
      return this.outcomeFromStatus(current.status, current.terminal_reason);
    }
    return outcome;
  }

  async cancel(
    turnId: string,
  ): Promise<{ cancelled: boolean; terminalOutcome?: TerminalOutcome }> {
    const active = await this.findActiveAttemptForTurn(turnId);
    if (!active) return { cancelled: false };
    const outcome = await this.markTerminal(
      active.attempt_id,
      "cancelled",
      "cancelled",
    );
    return { cancelled: true, terminalOutcome: outcome ?? "cancelled" };
  }

  /**
   * Retry a turn after a failure. Enforces the retry policy: only idempotent
   * failure classes create a new attempt, binding side effects require an
   * idempotency key, and cancellation races produce a single cancelled terminal.
   */
  async retry(
    turnId: string,
    failureClass: TurnFailureClass,
    options: RetryOptions = {},
  ): Promise<RetryResult | RetryRejected> {
    const attempts = await this.store.listByTurnId(turnId);
    const previous = options.previousAttemptId
      ? await this.store.get(options.previousAttemptId)
      : attempts[attempts.length - 1];

    if (!previous) {
      return { accepted: false, reason: "no previous attempt to retry" };
    }

    // Cancellation wins over any retry scheduling.
    if (previous.status !== "active" && previous.terminal_reason === "cancelled") {
      return {
        accepted: false,
        reason: "turn already cancelled",
        terminalOutcome: "cancelled",
      };
    }

    const evaluation = this.evaluateRetry(failureClass, options);
    if (!evaluation.retryable) {
      const outcome: TerminalOutcome =
        failureClass === "validation_loop" ? "aborted" : "failed";
      if (previous.status === "active") {
        await this.markTerminal(
          previous.attempt_id,
          outcome,
          options.reason ?? failureClass,
        );
      }
      return {
        accepted: false,
        reason: `failure class ${failureClass} is not retryable`,
        terminalOutcome: outcome,
      };
    }

    if (attempts.length >= this.config.maxAttempts) {
      if (previous.status === "active") {
        await this.markTerminal(
          previous.attempt_id,
          "failed",
          `max attempts (${this.config.maxAttempts}) reached`,
        );
      }
      return {
        accepted: false,
        reason: `max attempts (${this.config.maxAttempts}) reached`,
        terminalOutcome: "failed",
      };
    }

    // Projection-only retries do not supersede the original successful attempt's
    // events; the agent itself is not re-run.
    const supersededAttemptId =
      failureClass === "discord_projection" ? undefined : previous.attempt_id;

    if (previous.status === "active") {
      await this.store.update(previous.attempt_id, {
        status: "interrupted",
        terminal_at: this.clock.now(),
        terminal_reason: options.reason ?? failureClass,
      });
    }

    const attemptNumber =
      attempts.reduce((max, attempt) => Math.max(max, attempt.attempt_number), 0) +
      1;
    const now = this.clock.now();
    const retryReason = options.reason ?? failureClass;
    const record: TurnAttemptRecord = {
      attempt_id: makeAttemptId(),
      turn_id: turnId,
      attempt_number: attemptNumber,
      lease_owner: this.config.leaseOwner,
      heartbeat_at: now,
      started_at: now,
      timeout_ms: this.config.turnTimeoutMs,
      retry_reason: retryReason,
      terminal_reason: null,
      terminal_at: null,
      status: "active",
    };

    await this.store.insert(record);

    return {
      accepted: true,
      attemptId: record.attempt_id,
      attemptNumber,
      retryReason,
      supersededAttemptId,
    };
  }

  /**
   * Mark any active attempt whose heartbeat has expired as interrupted. This
   * releases the lease/slot it held.
   */
  async reconcileAfterRestart(): Promise<TurnAttemptRecord[]> {
    const active = await this.store.listActive();
    const interrupted: TurnAttemptRecord[] = [];
    const cutoff = this.clock.now().getTime() - this.config.heartbeatTimeoutMs;

    for (const attempt of active) {
      if (attempt.heartbeat_at.getTime() < cutoff) {
        const updated = await this.store.update(attempt.attempt_id, {
          status: "interrupted",
          terminal_at: this.clock.now(),
          terminal_reason: "heartbeat expired",
        });
        if (updated) interrupted.push(updated);
      }
    }

    return interrupted;
  }

  /**
   * Mark active attempts that have exceeded their wall-clock timeout as
   * terminal so they cannot hold a slot indefinitely.
   */
  async enforceTimeouts(): Promise<TurnAttemptRecord[]> {
    const active = await this.store.listActive();
    const timedOut: TurnAttemptRecord[] = [];
    const now = this.clock.now().getTime();

    for (const attempt of active) {
      if (now > attempt.started_at.getTime() + attempt.timeout_ms) {
        const updated = await this.store.update(attempt.attempt_id, {
          status: "failed",
          terminal_at: this.clock.now(),
          terminal_reason: "turn timeout",
        });
        if (updated) timedOut.push(updated);
      }
    }

    return timedOut;
  }

  async activeCount(): Promise<number> {
    return (await this.store.listActive()).length;
  }

  evaluateRetry(
    failureClass: TurnFailureClass,
    options: RetryOptions,
  ): { retryable: boolean; requiresIdempotencyKey: boolean } {
    switch (failureClass) {
      case "provider_transient":
        return {
          retryable: !options.sideEffectOccurred,
          requiresIdempotencyKey: false,
        };
      case "sidecar_crash":
      case "host_shutdown":
        return { retryable: true, requiresIdempotencyKey: false };
      case "discord_projection":
        return { retryable: true, requiresIdempotencyKey: false };
      case "binding_error":
        return {
          retryable: !!options.idempotencyKey,
          requiresIdempotencyKey: true,
        };
      case "validation_loop":
      case "timeout":
      case "unknown":
      default:
        return { retryable: false, requiresIdempotencyKey: false };
    }
  }

  private outcomeFromStatus(
    status: AttemptStatus,
    terminalReason: string | null,
  ): TerminalOutcome | undefined {
    if (status === "completed") return "completed";
    if (status === "failed") return "failed";
    if (status === "interrupted") {
      return terminalReason === "cancelled" ? "cancelled" : "failed";
    }
    return undefined;
  }

  private async findActiveAttemptForTurn(
    turnId: string,
  ): Promise<TurnAttemptRecord | undefined> {
    const attempts = await this.store.listByTurnId(turnId);
    return attempts.find((attempt) => attempt.status === "active");
  }
}

function makeAttemptId(): string {
  return `attempt-${randomUUID()}`;
}

function terminalStatusForOutcome(outcome: TerminalOutcome): AttemptStatus {
  switch (outcome) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "interrupted";
    case "aborted":
      return "failed";
  }
}
