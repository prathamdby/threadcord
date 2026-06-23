import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  CancelOutcome,
  ClaimedTurn,
  NewTaskRecord,
  TaskRecord,
  TaskStatus,
} from "../types.js";
import { ACTIVE_STATUSES, TASK_STATUSES } from "../types.js";

const SCHEDULER_LOCK_KEY = 8675309;

/** Statuses that can still accept a follow-up turn. */
const FOLLOWUP_ELIGIBLE = new Set<TaskStatus>(["queued", "running", "waiting"]);

/** Outcome of restart reconciliation, split by what each task became. */
export interface RestartReconciliation {
  /** Running turns lost to the restart, returned to `waiting`. */
  resumed: TaskRecord[];
  /** Cancellation-requested turns finalized to terminal `cancelled`. */
  cancelled: TaskRecord[];
}

/**
 * Result of enqueuing a follow-up. On success it carries the queue position and
 * the task's locked-in status so callers can decide scheduling from authoritative
 * state; on rejection the status explains why.
 */
export type FollowupResult =
  | { ok: true; position: number; status: TaskStatus }
  | { ok: false; status: TaskStatus };

/**
 * Store surface the orchestrator depends on. Declaring it lets tests drive the
 * cancellation lifecycle through an in-memory implementation with a fake
 * dispatch layer, exercising visible state rather than SQL text.
 */
export interface TaskStorePort {
  getByMessageId(messageId: string): Promise<TaskRecord | undefined>;
  getByThreadId(threadId: string): Promise<TaskRecord | undefined>;
  getByInstanceId(instanceId: string): Promise<TaskRecord | undefined>;
  createDraft(
    task: NewTaskRecord,
  ): Promise<{ task: TaskRecord; created: boolean }>;
  attachAndPromote(
    taskId: string,
    threadId: string,
    flueInstanceId: string,
    statusMessageId: string,
  ): Promise<TaskRecord | undefined>;
  markDraftFailed(
    taskId: string,
    errorSummary: string,
  ): Promise<TaskRecord | undefined>;
  claimNextTurn(preferTaskId?: string): Promise<ClaimedTurn | undefined>;
  queuePosition(taskId: string): Promise<number>;
  transition(
    taskId: string,
    from: TaskStatus | TaskStatus[],
    to: TaskStatus,
    errorSummary?: string,
  ): Promise<TaskRecord | undefined>;
  requestCancel(taskId: string): Promise<CancelOutcome>;
  reconcileAfterRestart(): Promise<RestartReconciliation>;
  enqueueFollowup(
    taskId: string,
    discordMessageId: string,
    instruction: string,
  ): Promise<FollowupResult>;
}

export class TaskStore implements TaskStorePort {
  constructor(
    private readonly pool: Pool,
    private readonly maxConcurrentTasks: number,
  ) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        discord_message_id TEXT NOT NULL UNIQUE,
        discord_thread_id TEXT NOT NULL UNIQUE,
        flue_instance_id TEXT NOT NULL UNIQUE,
        workspace_path TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        model TEXT NOT NULL,
        instruction TEXT NOT NULL,
        push_override TEXT,
        status TEXT NOT NULL,
        initial_turn_started BOOLEAN NOT NULL DEFAULT false,
        status_message_id TEXT,
        error_summary TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS initial_turn_started BOOLEAN NOT NULL DEFAULT false
    `);
    await this.pool.query(`
      ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check
    `);
    await this.pool.query(`
      ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('draft', 'queued', 'running', 'waiting', 'cancelling', 'completed', 'failed', 'cancelled'))
    `);
    // Neutralize any pre-existing orphan: a non-draft task that never got a
    // status message is exactly the bug this migration closes. Fail it before
    // adding the invariant so the constraint can be validated, and so the
    // scheduler never claims a legacy placeholder task on the next boot.
    await this.pool.query(`
      UPDATE tasks
      SET status = 'failed',
          error_summary = COALESCE(error_summary, 'Unattached task failed by schema migration'),
          updated_at = now()
      WHERE status <> 'draft' AND status_message_id IS NULL
    `);
    // Schema-level guarantee that unattached work cannot be scheduled. Only a
    // draft may lack a status message; every other status implies the Discord
    // thread and status message were attached at promotion time.
    await this.pool.query(`
      ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_attached_unless_draft_check
    `);
    await this.pool.query(`
      ALTER TABLE tasks ADD CONSTRAINT tasks_attached_unless_draft_check
      CHECK (status = 'draft' OR status_message_id IS NOT NULL)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS task_followups (
        id BIGSERIAL PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        discord_message_id TEXT NOT NULL UNIQUE,
        instruction TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  /**
   * Insert a non-schedulable draft keyed on the Discord message id. The draft
   * is the idempotency anchor written before any Discord side effect, so a
   * duplicate delivery loses the insert race (`created === false`) and never
   * creates a second thread. The scheduler ignores drafts, so a draft that is
   * never promoted cannot consume agent capacity.
   */
  async createDraft(
    task: NewTaskRecord,
  ): Promise<{ task: TaskRecord; created: boolean }> {
    const insert = await this.pool.query(
      `
        INSERT INTO tasks (
          id, discord_message_id, discord_thread_id, flue_instance_id, workspace_path,
          repo, branch, model, instruction, push_override, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
        ON CONFLICT (discord_message_id) DO NOTHING
        RETURNING *
      `,
      [
        task.id,
        task.discordMessageId,
        task.discordThreadId,
        task.flueInstanceId,
        task.workspacePath,
        task.repo,
        task.branch,
        task.model,
        task.instruction,
        task.pushOverride ?? null,
      ],
    );
    if (insert.rows[0]) {
      return { task: rowToTask(insert.rows[0]), created: true };
    }
    const existing = await this.getByMessageId(task.discordMessageId);
    if (!existing)
      throw new Error("Expected existing task after insert conflict");
    return { task: existing, created: false };
  }

  /**
   * Attach the real Discord identity and promote `draft` to `queued` in one
   * statement. Guarding on `status = 'draft'` keeps the promotion idempotent
   * under a retry and prevents clobbering a task that already advanced. Returns
   * undefined when the row was not a draft to promote.
   */
  async attachAndPromote(
    taskId: string,
    threadId: string,
    flueInstanceId: string,
    statusMessageId: string,
  ): Promise<TaskRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET discord_thread_id = $2,
            flue_instance_id = $3,
            status_message_id = $4,
            status = 'queued',
            updated_at = now()
        WHERE id = $1 AND status = 'draft'
        RETURNING *
      `,
      [taskId, threadId, flueInstanceId, statusMessageId],
    );
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  /**
   * Mark a draft terminally failed after Discord thread creation failed. The
   * task stays non-schedulable, so a partial side effect never becomes queued
   * work, and a later duplicate of the same message converges deterministically
   * on the failed record instead of retrying.
   */
  async markDraftFailed(
    taskId: string,
    errorSummary: string,
  ): Promise<TaskRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET status = 'failed', error_summary = $2, updated_at = now()
        WHERE id = $1 AND status = 'draft'
        RETURNING *
      `,
      [taskId, errorSummary],
    );
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  async getByThreadId(threadId: string): Promise<TaskRecord | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM tasks WHERE discord_thread_id = $1",
      [threadId],
    );
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  async getById(taskId: string): Promise<TaskRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM tasks WHERE id = $1", [
      taskId,
    ]);
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  async getByMessageId(messageId: string): Promise<TaskRecord | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM tasks WHERE discord_message_id = $1",
      [messageId],
    );
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  async getByInstanceId(instanceId: string): Promise<TaskRecord | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM tasks WHERE flue_instance_id = $1",
      [instanceId],
    );
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  async getModelForInstance(
    instanceId: string,
    fallbackModel: string,
  ): Promise<string> {
    const result = await this.pool.query(
      "SELECT model FROM tasks WHERE flue_instance_id = $1",
      [instanceId],
    );
    const model = result.rows[0]?.model;
    return typeof model === "string" && model.length > 0
      ? model
      : fallbackModel;
  }

  async claimNextTurn(preferTaskId?: string): Promise<ClaimedTurn | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        SCHEDULER_LOCK_KEY,
      ]);

      const active = await client.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE status = ANY($1::text[])",
        [[...ACTIVE_STATUSES]],
      );
      if (Number(singleRow(active.rows).count) >= this.maxConcurrentTasks) {
        await client.query("ROLLBACK");
        return undefined;
      }

      const claimed = await this.claimFollowupTurn(client, preferTaskId);
      if (claimed) {
        await client.query("COMMIT");
        return claimed;
      }

      const initial = await this.claimInitialTurn(client, preferTaskId);
      if (initial) {
        await client.query("COMMIT");
        return initial;
      }

      const globalFollowup = await this.claimFollowupTurn(client);
      if (globalFollowup) {
        await client.query("COMMIT");
        return globalFollowup;
      }

      await client.query("ROLLBACK");
      return undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async queuePosition(taskId: string): Promise<number> {
    const result = await this.pool.query(
      `
        SELECT COUNT(*)::int AS position
        FROM tasks
        WHERE status = 'queued'
          AND created_at <= (SELECT created_at FROM tasks WHERE id = $1)
      `,
      [taskId],
    );
    return Number(singleRow(result.rows).position);
  }

  async transition(
    taskId: string,
    from: TaskStatus | TaskStatus[],
    to: TaskStatus,
    errorSummary?: string,
  ): Promise<TaskRecord | undefined> {
    const fromStatuses = Array.isArray(from) ? from : [from];
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET status = $2,
            error_summary = CASE WHEN $3::text IS NULL THEN error_summary ELSE $3 END,
            updated_at = now()
        WHERE id = $1 AND status = ANY($4::text[])
        RETURNING *
      `,
      [taskId, to, errorSummary ?? null, fromStatuses],
    );
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  /**
   * Move a task toward cancellation honestly. Queued and waiting tasks have no
   * active turn, so they go straight to terminal `cancelled`. A running task
   * only reaches `cancelling`: its turn keeps a concurrency slot until the
   * runtime reports the turn ended. Pending follow-ups are dropped in both
   * cases so no new turn can be scheduled.
   */
  async requestCancel(taskId: string): Promise<CancelOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the task row first so a concurrent enqueueFollowup (which also
      // locks it FOR UPDATE) cannot interleave with the status change and its
      // follow-up cleanup.
      const locked = await client.query(
        "SELECT * FROM tasks WHERE id = $1 FOR UPDATE",
        [taskId],
      );
      const row = singleRow(locked.rows);
      const status = parseTaskStatus(row.status);

      if (status === "queued" || status === "waiting") {
        const updated = await this.finalizeCancel(client, taskId, "cancelled");
        await client.query("COMMIT");
        return { kind: "terminal", task: updated };
      }
      if (status === "running") {
        const updated = await this.finalizeCancel(client, taskId, "cancelling");
        await client.query("COMMIT");
        return { kind: "requested", task: updated };
      }

      await client.query("COMMIT");
      return { kind: "noop", task: rowToTask(row) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async finalizeCancel(
    client: PoolClient,
    taskId: string,
    to: "cancelled" | "cancelling",
  ): Promise<TaskRecord> {
    const updated = await client.query(
      "UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [taskId, to],
    );
    await dropFollowups(client, taskId);
    return rowToTask(singleRow(updated.rows));
  }

  /**
   * Settle in-flight state after a process restart. A running turn cannot
   * survive the restart, so it returns to `waiting` and can claim again. A
   * cancellation-requested turn is finalized to terminal `cancelled` instead of
   * resurrected, so a restart never reopens work the user already stopped. A
   * draft is an admission that never finished attaching its Discord thread, so
   * it is failed rather than promoted, keeping unattached work off the
   * scheduler after a crash.
   */
  async reconcileAfterRestart(): Promise<RestartReconciliation> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const resumed = await client.query(
        `
          UPDATE tasks
          SET status = 'waiting', updated_at = now()
          WHERE status = 'running'
          RETURNING *
        `,
      );
      const cancelled = await client.query(
        `
          UPDATE tasks
          SET status = 'cancelled', updated_at = now()
          WHERE status = 'cancelling'
          RETURNING *
        `,
      );
      await client.query(
        `
          UPDATE tasks
          SET status = 'failed',
              error_summary = COALESCE(error_summary, 'Draft abandoned before thread attachment, failed on restart'),
              updated_at = now()
          WHERE status = 'draft'
        `,
      );
      await client.query("COMMIT");
      return {
        resumed: resumed.rows.map(rowToTask),
        cancelled: cancelled.rows.map(rowToTask),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Enqueue a follow-up only while the task can still run one. The task row is
   * locked for the check so a concurrent cancel cannot slip a follow-up past
   * the eligibility gate and leave it orphaned. Terminal and cancelling tasks
   * are rejected with their current status.
   */
  async enqueueFollowup(
    taskId: string,
    discordMessageId: string,
    instruction: string,
  ): Promise<FollowupResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        "SELECT status FROM tasks WHERE id = $1 FOR UPDATE",
        [taskId],
      );
      const status = parseTaskStatus(singleRow(locked.rows).status);
      if (!FOLLOWUP_ELIGIBLE.has(status)) {
        await client.query("COMMIT");
        return { ok: false, status };
      }
      const insert = await client.query(
        `
          INSERT INTO task_followups (task_id, discord_message_id, instruction)
          VALUES ($1, $2, $3)
          ON CONFLICT (discord_message_id) DO NOTHING
          RETURNING id
        `,
        [taskId, discordMessageId, instruction],
      );
      const result = await client.query(
        `
          SELECT COUNT(*)::int AS position
          FROM task_followups
          WHERE task_id = $1
            AND id <= COALESCE($2::bigint, (
              SELECT id FROM task_followups
              WHERE task_id = $1 AND discord_message_id = $3
            ))
        `,
        [taskId, insert.rows[0]?.id ?? null, discordMessageId],
      );
      await client.query("COMMIT");
      return {
        ok: true,
        position: Number(singleRow(result.rows).position),
        status,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listExpiredWorkspacePaths(ttlDays: number): Promise<string[]> {
    const result = await this.pool.query(
      `
        SELECT workspace_path
        FROM tasks
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND updated_at < now() - ($1::text || ' days')::interval
      `,
      [String(ttlDays)],
    );
    return result.rows
      .map((row) => row.workspace_path)
      .filter((path): path is string => typeof path === "string");
  }

  async health(): Promise<boolean> {
    await this.pool.query("SELECT 1");
    return true;
  }

  private async claimInitialTurn(
    client: PoolClient,
    preferTaskId?: string,
  ): Promise<ClaimedTurn | undefined> {
    const result = await client.query(
      `
        UPDATE tasks
        SET status = 'running',
            initial_turn_started = true,
            updated_at = now()
        WHERE id = (
          SELECT id FROM tasks
          WHERE status = 'queued'
            AND ($1::text IS NULL OR id = $1)
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *
      `,
      [preferTaskId ?? null],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const task = rowToTask(row);
    return { task, instruction: task.instruction, source: "initial" };
  }

  private async claimFollowupTurn(
    client: PoolClient,
    preferTaskId?: string,
  ): Promise<ClaimedTurn | undefined> {
    const result = await client.query(
      `
        WITH candidate AS (
          SELECT f.id AS followup_id, f.instruction, t.id AS task_id
          FROM task_followups f
          JOIN tasks t ON t.id = f.task_id
          WHERE t.status = 'waiting'
            AND t.initial_turn_started = true
            AND ($1::text IS NULL OR t.id = $1)
          ORDER BY f.created_at, f.id
          FOR UPDATE OF f, t SKIP LOCKED
          LIMIT 1
        ),
        deleted AS (
          DELETE FROM task_followups
          WHERE id = (SELECT followup_id FROM candidate)
          RETURNING instruction
        ),
        updated AS (
          UPDATE tasks
          SET status = 'running', updated_at = now()
          WHERE id = (SELECT task_id FROM candidate)
          RETURNING *
        )
        SELECT updated.*, deleted.instruction AS run_instruction
        FROM updated
        JOIN deleted ON true
      `,
      [preferTaskId ?? null],
    );
    const row = result.rows[0];
    if (!row || typeof row.run_instruction !== "string") return undefined;
    const task = rowToTask(row);
    return { task, instruction: row.run_instruction, source: "followup" };
  }
}

function dropFollowups(client: PoolClient, taskId: string): Promise<unknown> {
  return client.query("DELETE FROM task_followups WHERE task_id = $1", [taskId]);
}

function singleRow<T extends QueryResultRow>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("Expected one row");
  return row;
}

function parseTaskStatus(value: unknown): TaskStatus {
  if (
    typeof value === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value)
  ) {
    return value as TaskStatus;
  }
  throw new Error(`Invalid task status: ${String(value)}`);
}

function rowToTask(row: QueryResultRow): TaskRecord {
  return {
    id: String(row.id),
    discordMessageId: String(row.discord_message_id),
    discordThreadId: String(row.discord_thread_id),
    flueInstanceId: String(row.flue_instance_id),
    workspacePath: String(row.workspace_path),
    repo: String(row.repo),
    branch: String(row.branch),
    model: String(row.model),
    instruction: String(row.instruction),
    ...(typeof row.push_override === "string"
      ? { pushOverride: row.push_override }
      : {}),
    status: parseTaskStatus(row.status),
    initialTurnStarted: Boolean(row.initial_turn_started),
    ...(typeof row.status_message_id === "string"
      ? { statusMessageId: row.status_message_id }
      : {}),
    ...(typeof row.error_summary === "string"
      ? { errorSummary: row.error_summary }
      : {}),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}
