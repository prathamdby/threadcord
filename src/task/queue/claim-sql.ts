import type { PoolClient, QueryResultRow } from "pg";
import type { TaskRecord } from "../../types.js";
import { rowToTask } from "../store.js";
import type { ClaimedTurn } from "../../types.js";

export async function countRunningTasksOnClient(
  client: PoolClient,
): Promise<number> {
  const running = await client.query(
    "SELECT COUNT(*)::int AS count FROM tasks WHERE status = 'running'",
  );
  const row = running.rows[0];
  if (!row) return 0;
  return Number(row.count);
}

export async function claimInitialTurnOnClient(
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

export async function claimFollowupTurnOnClient(
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
  const row = result.rows[0] as QueryResultRow & {
    run_instruction?: string;
    run_initiator_message_id?: string;
  };
  if (!row || typeof row.run_instruction !== "string") return undefined;
  const task = rowToTask(row);
  return {
    task,
    instruction: row.run_instruction,
    source: "followup",
    initiatorMessageId: String(row.run_initiator_message_id),
  };
}