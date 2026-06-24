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
        error_summary TEXT,
        setup_profile_revision INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
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
      ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check
    `);
    await this.pool.query(`
      ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('draft', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'))
    `);
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

  async markDraftFailed(
    taskId: string,
    errorSummary: string,
  ): Promise<TaskRecord | undefined> {
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET status = 'failed',
            error_summary = $2,
            status_message_id = COALESCE(status_message_id, 'unattached:' || id),
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
            status_message_id = COALESCE(status_message_id, 'unattached:' || id),
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
    setupProfileRevision: Number(row.setup_profile_revision),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}
