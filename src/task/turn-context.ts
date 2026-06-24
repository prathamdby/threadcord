import { basename, join } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { getPool } from "../db.js";
import { TaskStore } from "./store.js";
import type { TaskRecord } from "../types.js";

export interface AgentRuntimeContext {
  model: string;
  cwd: string;
  repo: string;
  baseBranch: string;
}

export function checkoutPathForTask(task: TaskRecord): string {
  return join(task.workspacePath, basename(task.repo));
}

export async function resolveAgentRuntimeContext(
  instanceId: string,
  _env: Record<string, unknown>,
): Promise<AgentRuntimeContext> {
  const store = new TaskStore(getPool(), 1);
  const task = await store.getByInstanceId(instanceId);
  if (!task) {
    throw new Error(
      `No Threadcord task found for agent instance ${instanceId}`,
    );
  }

  const config = getRuntimeConfig();

  return {
    model: task.model || config.defaultModel,
    cwd: checkoutPathForTask(task),
    repo: task.repo,
    baseBranch: task.branch,
  };
}
