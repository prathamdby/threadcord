import { PgBoss, type ConstructorOptions, type QueueOptions } from "pg-boss";
import {
  TASK_TURN_DEAD_LETTER_QUEUE,
  TASK_TURN_QUEUE,
} from "./constants.js";

export interface TaskQueueConfig {
  queueRetryLimit: number;
  queueRetryDelaySeconds: number;
  queueRetryDelayMaxSeconds: number;
  queueExpireInSeconds: number;
  queueHeartbeatSeconds: number;
  queueRetentionSeconds: number;
  queueDeleteAfterSeconds: number;
  queuePollingIntervalSeconds: number;
  taskTurnConcurrency: number;
}

function queueDefaults(cfg: TaskQueueConfig): QueueOptions {
  return {
    retryLimit: cfg.queueRetryLimit,
    retryDelay: cfg.queueRetryDelaySeconds,
    retryBackoff: true,
    retryDelayMax: cfg.queueRetryDelayMaxSeconds,
    expireInSeconds: cfg.queueExpireInSeconds,
    heartbeatSeconds: cfg.queueHeartbeatSeconds,
    retentionSeconds: cfg.queueRetentionSeconds,
    deleteAfterSeconds: cfg.queueDeleteAfterSeconds,
  };
}

export function bossConstructorOptions(databaseUrl: string): ConstructorOptions {
  return {
    connectionString: databaseUrl,
    application_name: "threadcord",
    schedule: true,
    supervise: true,
  };
}

export async function createStartedBoss(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss(bossConstructorOptions(databaseUrl));
  boss.on("error", (error) => {
    console.error("[threadcord] pg-boss error", error.message);
  });
  boss.on("warning", (warning) => {
    console.warn("[threadcord] pg-boss warning", warning.message);
  });
  await boss.start();
  return boss;
}

export async function ensureTaskTurnQueues(
  boss: PgBoss,
  cfg: TaskQueueConfig,
): Promise<void> {
  const defaults = queueDefaults(cfg);
  await boss.createQueue(TASK_TURN_DEAD_LETTER_QUEUE, {
    retryLimit: 0,
    deleteAfterSeconds: cfg.queueDeleteAfterSeconds,
    retentionSeconds: cfg.queueRetentionSeconds,
  });
  await boss.createQueue(TASK_TURN_QUEUE, {
    ...defaults,
    policy: "standard",
    deadLetter: TASK_TURN_DEAD_LETTER_QUEUE,
  });
}

export async function stopBoss(boss: PgBoss, drainTimeoutMs: number): Promise<void> {
  await boss.stop({ close: true, graceful: true, timeout: drainTimeoutMs });
}

export function taskTurnWorkOptions(cfg: TaskQueueConfig): {
  localConcurrency: number;
  pollingIntervalSeconds: number;
} {
  return {
    localConcurrency: cfg.taskTurnConcurrency,
    pollingIntervalSeconds: cfg.queuePollingIntervalSeconds,
  };
}