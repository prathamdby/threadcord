import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  ClaimedTurn,
  NewTaskRecord,
  TaskRecord,
  TaskStatus,
} from "../types.js";
import { TASK_STATUSES } from "../types.js";

const SCHEDULER_LOCK_KEY = 8675309;

export class TaskStore {
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
        header_message_id TEXT,
        error_summary TEXT,
        setup_profile_revision INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS push_override TEXT,
      ADD COLUMN IF NOT EXISTS status_message_id TEXT,
      ADD COLUMN IF NOT EXISTS error_summary TEXT
    `);
    await this.pool.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS flue_instance_id TEXT
    `);
    await this.pool.query(`
      UPDATE tasks
      SET flue_instance_id = CASE
        WHEN discord_thread_id LIKE 'pending:%' THEN discord_thread_id
        WHEN discord_thread_id IS NOT NULL THEN 'discord:thread:' || discord_thread_id
        ELSE 'legacy:' || id
      END
      WHERE flue_instance_id IS NULL
    `);
    await this.pool.query(`
      ALTER TABLE tasks ALTER COLUMN flue_instance_id SET NOT NULL
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_flue_instance_id_key ON tasks (flue_instance_id)
    `);
    await this.pool.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS initial_turn_started BOOLEAN NOT NULL DEFAULT false
    `);
    await this.pool.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS setup_profile_revision INTEGER NOT NULL DEFAULT 0
    `);
    await this.pool.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS progress_message_ids TEXT[]
    `);
    await this.pool.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS header_message_id TEXT
    `);
    await this.pool.query(`
      UPDATE tasks
      SET progress_message_ids = ARRAY[status_message_id]
      WHERE status_message_id IS NOT NULL AND progress_message_ids IS NULL
    `);
    await this.pool.query(`
      ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check
    `);
    await this.pool.query(`
      ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('draft', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'))
    `);
    // Deployed DB already enforces this invariant; no legacy orphan backfill here.
    await this.pool.query(`
      ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_attached_unless_draft_check
    `);
    await this.pool.query(`
      ALTER TABLE tasks ADD CONSTRAINT tasks_attached_unless_draft_check
      CHECK (status = 'draft' OR progress_message_ids IS NOT NULL OR status_message_id IS NOT NULL)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status)
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
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS task_turns (
        id UUID PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('initial', 'followup')),
        instruction TEXT NOT NULL,
        discord_message_id TEXT UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cancelled', 'completed', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        cancel_requested_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS task_turns_task_status_idx ON task_turns(task_id, status)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS task_turns_retention_idx ON task_turns(status, updated_at)
    `);
    // One-time backfill: copy pending followups from the legacy
    // task_followups table into task_turns for tasks still in a non-terminal
    // state. Backfilled turns have rows but no pg-boss jobs; plan 004's boot
    // reconciliation enqueues jobs for orphaned queued turns. Idempotent via
    // ON CONFLICT DO NOTHING.
    await this.pool.query(`
      INSERT INTO task_turns (id, task_id, source, instruction, discord_message_id, status, created_at)
      SELECT gen_random_uuid(), f.task_id, 'followup', f.instruction, f.discord_message_id, 'queued', f.created_at
      FROM task_followups f
      JOIN tasks t ON t.id = f.task_id
      WHERE t.status IN ('queued', 'running', 'waiting')
      ON CONFLICT (discord_message_id) DO NOTHING
    `);
  }

  async createDraft(
    task: NewTaskRecord,
  ): Promise<{ task: TaskRecord; created: boolean }> {
    const insert = await this.pool.query(
      `
        INSERT INTO tasks (
          id, discord_message_id, discord_thread_id, flue_instance_id, workspace_path,
          repo, branch, model, instruction, push_override, status, setup_profile_revision
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11)
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
        task.setupProfileRevision,
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

  async attachAndPromote(
    taskId: string,
    threadId: string,
    flueInstanceId: string,
    statusMessageId: string,
    headerMessageId?: string,
  ): Promise<TaskRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET discord_thread_id = $2,
            flue_instance_id = $3,
            progress_message_ids = ARRAY[$4],
            header_message_id = $5,
            status = 'queued',
            updated_at = now()
        WHERE id = $1 AND status = 'draft'
        RETURNING *
      `,
      [
        taskId,
        threadId,
        flueInstanceId,
        statusMessageId,
        headerMessageId ?? null,
      ],
    );
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  async appendProgressMessageId(
    taskId: string,
    messageId: string,
  ): Promise<TaskRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET progress_message_ids =
              COALESCE(
                progress_message_ids,
                CASE WHEN status_message_id IS NOT NULL
                  THEN ARRAY[status_message_id]
                  ELSE ARRAY[]::text[]
                END
              ) || $2::text[],
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [taskId, [messageId]],
    );
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  async markDraftFailed(
    taskId: string,
    errorSummary: string,
  ): Promise<TaskRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET status = 'failed',
            error_summary = $2,
            progress_message_ids = COALESCE(progress_message_ids, ARRAY['unattached:' || id]),
            updated_at = now()
        WHERE id = $1 AND status = 'draft'
        RETURNING *
      `,
      [taskId, errorSummary],
    );
    return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
  }

  async failAbandonedDrafts(): Promise<TaskRecord[]> {
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET status = 'failed',
            error_summary = COALESCE(
              error_summary,
              'Draft abandoned before thread attachment'
            ),
            progress_message_ids = COALESCE(progress_message_ids, ARRAY['unattached:' || id]),
            updated_at = now()
        WHERE status = 'draft'
        RETURNING *
      `,
    );
    return result.rows.map(rowToTask);
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

      const running = await client.query(
        "SELECT COUNT(*)::int AS count FROM tasks WHERE status = 'running'",
      );
      if (Number(singleRow(running.rows).count) >= this.maxConcurrentTasks) {
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

  async queueSnapshot(
    taskId: string,
  ): Promise<{ position: number; depth: number }> {
    const result = await this.pool.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE created_at <= (SELECT created_at FROM tasks WHERE id = $1)
          )::int AS position,
          COUNT(*)::int AS depth
        FROM tasks
        WHERE status = 'queued'
      `,
      [taskId],
    );
    const row = singleRow(result.rows);
    return {
      position: Number(row.position),
      depth: Number(row.depth),
    };
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

  async cancelTask(taskId: string): Promise<TaskRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
          UPDATE tasks
          SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'waiting', 'running')
          RETURNING *
        `,
        [taskId],
      );
      await client.query("DELETE FROM task_followups WHERE task_id = $1", [
        taskId,
      ]);
      await client.query("COMMIT");
      return result.rows[0] ? rowToTask(result.rows[0]) : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseRunningAfterRestart(): Promise<TaskRecord[]> {
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET status = 'waiting', updated_at = now()
        WHERE status = 'running'
        RETURNING *
      `,
    );
    return result.rows.map(rowToTask);
  }

  async enqueueFollowup(
    taskId: string,
    discordMessageId: string,
    instruction: string,
  ): Promise<number> {
    const insert = await this.pool.query(
      `
        INSERT INTO task_followups (task_id, discord_message_id, instruction)
        VALUES ($1, $2, $3)
        ON CONFLICT (discord_message_id) DO NOTHING
        RETURNING id
      `,
      [taskId, discordMessageId, instruction],
    );
    const result = await this.pool.query(
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
    return Number(singleRow(result.rows).position);
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
    return {
      task,
      instruction: task.instruction,
      source: "initial",
      initiatorMessageId: task.discordMessageId,
    };
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
          RETURNING instruction, discord_message_id
        ),
        updated AS (
          UPDATE tasks
          SET status = 'running', updated_at = now()
          WHERE id = (SELECT task_id FROM candidate)
          RETURNING *
        )
        SELECT updated.*, deleted.instruction AS run_instruction, deleted.discord_message_id AS run_initiator_message_id
        FROM updated
        JOIN deleted ON true
      `,
      [preferTaskId ?? null],
    );
    const row = result.rows[0];
    if (!row || typeof row.run_instruction !== "string") return undefined;
    const task = rowToTask(row);
    return {
      task,
      instruction: row.run_instruction,
      source: "followup",
      initiatorMessageId: String(row.run_initiator_message_id),
    };
  }
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

export function progressMessageIdsFromRow(row: QueryResultRow): {
  progressMessageIds?: string[];
  statusMessageId?: string;
} {
  const ids = row.progress_message_ids;
  if (Array.isArray(ids) && ids.length > 0) {
    return { progressMessageIds: ids.map(String) };
  }
  if (typeof row.status_message_id === "string") {
    return {
      progressMessageIds: [row.status_message_id],
      statusMessageId: row.status_message_id,
    };
  }
  return {};
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
    ...progressMessageIdsFromRow(row),
    ...(typeof row.header_message_id === "string"
      ? { headerMessageId: row.header_message_id }
      : {}),
    ...(typeof row.error_summary === "string"
      ? { errorSummary: row.error_summary }
      : {}),
    setupProfileRevision: Number(row.setup_profile_revision),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}
