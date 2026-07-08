import type { AppConfig } from "../config.js";
import { PgBoss } from "pg-boss";

export const TASK_TURN_QUEUE = "task-turn";
export const TASK_TURN_DEAD_LETTER_QUEUE = "task-turn-dead";

/**
 * Construct and start a pg-boss instance. Threadcord is single-process, so the
 * maintenance flags (`schedule`, `supervise`) are unconditionally on; there is
 * no web/worker role split yet.
 */
export async function createStartedBoss(
  config: AppConfig,
): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    application_name: "threadcord",
    schedule: true,
    supervise: true,
  });
  boss.on("error", (error) => {
    console.error("[threadcord] pg-boss error", error);
  });
  boss.on("warning", (warning) => {
    console.warn("[threadcord] pg-boss warning", warning);
  });
  await boss.start();
  return boss;
}

/**
 * Create the task-turn dead-letter queue first, then the main task-turn queue.
 * The main queue uses `key_strict_fifo` so at most one job per singleton key
 * (the task id, wired in plan 003) is active, FIFO within the key. Retries use
 * exponential backoff bounded by `QUEUE_RETRY_DELAY_MAX_SECONDS`; heartbeats
 * let `supervise` recover crashed turns. Retention and post-completion
 * deletion both ride `TURN_RETENTION_DAYS` (days, matching `WORKSPACE_TTL_DAYS`).
 */
export async function ensureTaskQueues(
  boss: PgBoss,
  config: AppConfig,
): Promise<void> {
  await boss.createQueue(TASK_TURN_DEAD_LETTER_QUEUE, {
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
  });

  const retentionSeconds = config.TURN_RETENTION_DAYS * 86_400;
  await boss.createQueue(TASK_TURN_QUEUE, {
    retryLimit: config.QUEUE_RETRY_LIMIT,
    retryDelay: config.QUEUE_RETRY_DELAY_SECONDS,
    retryBackoff: true,
    retryDelayMax: config.QUEUE_RETRY_DELAY_MAX_SECONDS,
    expireInSeconds: config.QUEUE_EXPIRE_IN_SECONDS,
    heartbeatSeconds: config.QUEUE_HEARTBEAT_SECONDS,
    retentionSeconds,
    deleteAfterSeconds: retentionSeconds,
    policy: "key_strict_fifo",
    deadLetter: TASK_TURN_DEAD_LETTER_QUEUE,
  });
}

/**
 * Drain pg-boss gracefully before the shared pg pool is closed. Stopping the
 * boss first avoids maintenance queries hitting a closed pool during shutdown.
 */
export async function stopBoss(
  boss: PgBoss,
  drainTimeoutMs = 25_000,
): Promise<void> {
  await boss.stop({ close: true, graceful: true, timeout: drainTimeoutMs });
}
