import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { TaskRecord } from "../../types.js";
import { rowToTask } from "../store.js";
import { TASK_TURN_QUEUE } from "./constants.js";
import { pgBossDb } from "./pg-boss-db.js";
import type { ClaimedTurn } from "../../types.js";
import type { TaskTurnJobData } from "./types.js";
import {
  claimFollowupTurnOnClient,
  claimInitialTurnOnClient,
  countRunningTasksOnClient,
} from "./claim-sql.js";

const SCHEDULER_LOCK_KEY = 8675309;

export class TaskTurnScheduler {
  constructor(
    private readonly pool: Pool,
    private readonly boss: PgBoss,
    private readonly maxConcurrentTasks: number,
  ) {}

  /**
   * Claims the next turn under advisory lock and enqueues a durable pg-boss job
   * in the same transaction (pr-agent-style intake).
   */
  async claimAndEnqueueNextTurn(
    preferTaskId?: string,
  ): Promise<ClaimedTurn | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        SCHEDULER_LOCK_KEY,
      ]);

      const running = await countRunningTasksOnClient(client);
      if (running >= this.maxConcurrentTasks) {
        await client.query("ROLLBACK");
        return undefined;
      }

      let claimed =
        (await claimFollowupTurnOnClient(client, preferTaskId)) ??
        (await claimInitialTurnOnClient(client, preferTaskId)) ??
        (await claimFollowupTurnOnClient(client));

      if (!claimed) {
        await client.query("ROLLBACK");
        return undefined;
      }

      const jobData: TaskTurnJobData = {
        taskId: claimed.task.id,
        instruction: claimed.instruction,
        source: claimed.source,
        initiatorMessageId: claimed.initiatorMessageId,
      };

      const jobId = await this.boss.send(TASK_TURN_QUEUE, jobData, {
        db: pgBossDb(client),
      });
      if (jobId == null) {
        await client.query("ROLLBACK");
        throw new Error("pg-boss did not enqueue threadcord task turn job");
      }

      await client.query("COMMIT");
      return claimed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Drain available concurrency slots by enqueueing turns. */
  async fillConcurrencySlots(): Promise<ClaimedTurn[]> {
    const enqueued: ClaimedTurn[] = [];
    for (;;) {
      const claimed = await this.claimAndEnqueueNextTurn();
      if (!claimed) break;
      enqueued.push(claimed);
    }
    return enqueued;
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM tasks WHERE id = $1", [
      taskId,
    ]);
    const row = result.rows[0];
    if (!row) return undefined;
    return rowToTask(row);
  }
}