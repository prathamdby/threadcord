import type { Job } from "pg-boss";
import type { PgBoss } from "pg-boss";
import { TASK_TURN_QUEUE } from "./constants.js";
import type { TaskQueueConfig } from "./boss.js";
import { taskTurnWorkOptions } from "./boss.js";
import type { TaskTurnJobData } from "./types.js";
import type { TaskOrchestrator } from "../orchestrator.js";

export async function registerTaskTurnWorker(
  boss: PgBoss,
  cfg: TaskQueueConfig,
  orchestrator: TaskOrchestrator,
): Promise<void> {
  const options = taskTurnWorkOptions(cfg);
  await boss.work<TaskTurnJobData>(
    TASK_TURN_QUEUE,
    options,
    async (jobs) => {
      const job = jobs[0];
      if (!job) return;
      await orchestrator.executeTurnJob(job);
    },
  );
}