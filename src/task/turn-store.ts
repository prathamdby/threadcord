import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { TaskTurnRecord, TurnStatus } from "../types.js";
import { TURN_STATUSES } from "../types.js";

/** Pool or pooled client: both expose the same `query(text, values?)` shape. */
type Queryable = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: QueryResultRow[]; rowCount: number | null }>;
};

const TERMINAL_TURN_STATUSES: readonly TurnStatus[] = [
  "cancelled",
  "completed",
  "failed",
];

export class TurnStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert a new turn seeded with `status='queued'`. Idempotent on
   * `discord_message_id` so a redelivered intake job cannot double-insert.
   * `created` is false when the insert was skipped by the conflict rule.
   */
  async insertTurn(
    turn: {
      id: string;
      taskId: string;
      source: "initial" | "followup";
      instruction: string;
      discordMessageId?: string;
    },
    client?: PoolClient,
  ): Promise<{ created: boolean }> {
    const exec: Queryable = (client ?? this.pool) as Queryable;
    const result = await exec.query(
      `
        INSERT INTO task_turns (id, task_id, source, instruction, discord_message_id, status)
        VALUES ($1, $2, $3, $4, $5, 'queued')
        ON CONFLICT (discord_message_id) DO NOTHING
      `,
      [
        turn.id,
        turn.taskId,
        turn.source,
        turn.instruction,
        turn.discordMessageId ?? null,
      ],
    );
    return { created: (result.rowCount ?? 0) > 0 };
  }

  /**
   * One-query claim: atomic queued→running transition that bumps
   * `attempt_count` and stamps `started_at`. Returns the claimed row, or
   * undefined if the turn was not claimable (already running, terminal, or
   * cancel-requested).
   */
  async claimQueuedTurn(
    turnId: string,
  ): Promise<TaskTurnRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE task_turns
           SET status = 'running',
               started_at = COALESCE(started_at, now()),
               attempt_count = attempt_count + 1,
               updated_at = now()
         WHERE id = $1 AND status = 'queued' AND cancel_requested_at IS NULL
        RETURNING *
      `,
      [turnId],
    );
    return result.rows[0] ? rowToTurn(result.rows[0]) : undefined;
  }

  /**
   * Resume-aware claim used by pg-boss redeliveries. Try the normal claim
   * UPDATE first; if it matches nothing, the turn is already running from a
   * prior delivery, so re-read it and return true iff we still own it
   * (`status='running'` and no cancel requested). The resume path must NOT
   * bump `attempt_count` — the original claim already counted the attempt.
   */
  async resumeTurnForExecution(turnId: string): Promise<boolean> {
    const claim = await this.pool.query(
      `
        UPDATE task_turns
           SET status = 'running',
               started_at = COALESCE(started_at, now()),
               attempt_count = attempt_count + 1,
               updated_at = now()
         WHERE id = $1 AND status = 'queued' AND cancel_requested_at IS NULL
      `,
      [turnId],
    );
    if ((claim.rowCount ?? 0) > 0) return true;
    const result = await this.pool.query(
      "SELECT status, cancel_requested_at FROM task_turns WHERE id = $1",
      [turnId],
    );
    const row = result.rows[0];
    if (!row) return false;
    return (
      row.status === "running" && row.cancel_requested_at === null
    );
  }

  /** Complete a running, non-cancelled turn. Returns false on a lost race. */
  async markTurnCompleted(turnId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE task_turns
           SET status = 'completed',
               completed_at = now(),
               updated_at = now()
         WHERE id = $1 AND status = 'running' AND cancel_requested_at IS NULL
      `,
      [turnId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Fail a running, non-cancelled turn, recording the error. Returns false on a lost race. */
  async markTurnFailed(turnId: string, lastError: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE task_turns
           SET status = 'failed',
               last_error = $2,
               completed_at = now(),
               updated_at = now()
         WHERE id = $1 AND status = 'running' AND cancel_requested_at IS NULL
      `,
      [turnId, lastError],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Return a running, non-cancelled turn to the queue for retry, recording the
   * error. Does NOT touch `attempt_count` — the next claim bumps it. Returns
   * false on a lost race.
   */
  async markTurnRetrying(
    turnId: string,
    lastError: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE task_turns
           SET status = 'queued',
               last_error = $2,
               updated_at = now()
         WHERE id = $1 AND status = 'running' AND cancel_requested_at IS NULL
      `,
      [turnId, lastError],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Request cancellation unconditionally. Cancellation is a gate, not a
   * status: the running worker checks `cancel_requested_at` between steps and
   * stops; guarded completions reject the row. Idempotent via COALESCE.
   */
  async requestCancel(turnId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE task_turns
           SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
               updated_at = now()
         WHERE id = $1
      `,
      [turnId],
    );
  }

  /**
   * Finalize cancellation for a turn still in a claimable state. Unlike the
   * guarded boolean racers, this is unconditional cleanup: a cancel-requested
   * turn that already completed/failed keeps its terminal status.
   */
  async markTurnCancelled(turnId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE task_turns
           SET status = 'cancelled',
               completed_at = COALESCE(completed_at, now()),
               updated_at = now()
         WHERE id = $1 AND status IN ('queued', 'running')
      `,
      [turnId],
    );
  }

  /**
   * Cancel every queued turn of a task, returning the cancelled turn ids so
   * plan 004 can cancel the matching pg-boss jobs.
   */
  async cancelPendingTurnsForTask(
    taskId: string,
    client?: PoolClient,
  ): Promise<string[]> {
    const exec: Queryable = (client ?? this.pool) as Queryable;
    const result = await exec.query(
      `
        UPDATE task_turns
           SET status = 'cancelled',
               completed_at = COALESCE(completed_at, now()),
               updated_at = now()
         WHERE task_id = $1 AND status = 'queued'
        RETURNING id
      `,
      [taskId],
    );
    return result.rows.map((row) => String(row.id));
  }

  /**
   * Checkpoint predicate the turn executor calls between execution steps.
   * True when the row is missing, terminal, or has a cancel requested — any
   * of which means the worker should abandon further work.
   */
  async shouldSkipTurn(turnId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT status, cancel_requested_at FROM task_turns WHERE id = $1",
      [turnId],
    );
    const row = result.rows[0];
    if (!row) return true;
    if (
      typeof row.status === "string" &&
      (TERMINAL_TURN_STATUSES as readonly string[]).includes(row.status)
    ) {
      return true;
    }
    return row.cancel_requested_at !== null && row.cancel_requested_at !== undefined;
  }

  async getTurn(turnId: string): Promise<TaskTurnRecord | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM task_turns WHERE id = $1",
      [turnId],
    );
    return result.rows[0] ? rowToTurn(result.rows[0]) : undefined;
  }

  /**
   * List every turn currently in `running` status. Used at boot to find turns
   * interrupted by a crash so they can be requeued (plan 004 restart recovery).
   */
  async listRunningTurns(): Promise<TaskTurnRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM task_turns WHERE status = 'running' ORDER BY created_at, id",
    );
    return result.rows.map(rowToTurn);
  }

  /**
   * List every turn currently in `queued` status. Used at boot to find turns
   * that have no pg-boss job (backfilled follow-ups) so a fresh job can be
   * sent (plan 004 restart recovery).
   */
  async listQueuedTurns(): Promise<TaskTurnRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM task_turns WHERE status = 'queued' ORDER BY created_at, id",
    );
    return result.rows.map(rowToTurn);
  }

  /**
   * Reset a single interrupted turn from `running` back to `queued` so a fresh
   * pg-boss job can pick it up. `attempt_count` is intentionally preserved —
   * the original claim already counted the attempt. Returns false on a lost
   * race (turn no longer running).
   */
  async requeueInterruptedTurn(turnId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE task_turns
           SET status = 'queued', updated_at = now()
         WHERE id = $1 AND status = 'running'
      `,
      [turnId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Delete terminal turns older than `retentionDays`, in batches of
   * `batchSize`. Returns the number of rows deleted; plan 004 loops until 0.
   */
  async deleteAgedTerminalTurns(
    retentionDays: number,
    batchSize: number,
  ): Promise<number> {
    const result = await this.pool.query(
      `
        DELETE FROM task_turns
         WHERE ctid IN (
           SELECT ctid FROM task_turns
           WHERE status IN ('completed', 'failed', 'cancelled')
             AND updated_at < now() - ($1::text || ' days')::interval
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
      `,
      [String(retentionDays), batchSize],
    );
    return result.rowCount ?? 0;
  }
}

function parseTurnStatus(value: unknown): TurnStatus {
  if (
    typeof value === "string" &&
    (TURN_STATUSES as readonly string[]).includes(value)
  ) {
    return value as TurnStatus;
  }
  throw new Error(`Invalid turn status: ${String(value)}`);
}

function parseTurnSource(value: unknown): "initial" | "followup" {
  if (value === "initial" || value === "followup") return value;
  throw new Error(`Invalid turn source: ${String(value)}`);
}

function rowToTurn(row: QueryResultRow): TaskTurnRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    source: parseTurnSource(row.source),
    instruction: String(row.instruction),
    ...(typeof row.discord_message_id === "string"
      ? { discordMessageId: row.discord_message_id }
      : {}),
    status: parseTurnStatus(row.status),
    attemptCount: Number(row.attempt_count),
    ...(row.cancel_requested_at
      ? { cancelRequestedAt: new Date(String(row.cancel_requested_at)) }
      : {}),
    ...(typeof row.last_error === "string" ? { lastError: row.last_error } : {}),
    createdAt: new Date(String(row.created_at)),
    ...(row.started_at ? { startedAt: new Date(String(row.started_at)) } : {}),
    ...(row.completed_at
      ? { completedAt: new Date(String(row.completed_at)) }
      : {}),
    updatedAt: new Date(String(row.updated_at)),
  };
}
