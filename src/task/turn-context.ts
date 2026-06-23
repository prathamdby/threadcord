import { basename, join } from "node:path";
import { loadConfig } from "../config.js";
import { getPool } from "../db.js";
import { targetBranchForTask } from "./policy.js";
import { TaskStore } from "./store.js";
import type { TaskRecord } from "../types.js";

export interface AgentRuntimeContext {
  model: string;
  cwd: string;
  repo: string;
  baseBranch: string;
  featureBranch: string;
  allowedRepos: string[];
}

export function checkoutPathForTask(task: TaskRecord): string {
  return join(task.workspacePath, basename(task.repo));
}

export async function resolveAgentRuntimeContext(
  instanceId: string,
  env: Record<string, unknown>,
): Promise<AgentRuntimeContext> {
  const store = new TaskStore(getPool(), 1);
  const task = await store.getByInstanceId(instanceId);
  if (!task) {
    throw new Error(
      `No Threadcord task found for agent instance ${instanceId}`,
    );
  }

  const defaultModel = loadConfig().defaultModel;
  const allowedRepos = parseAllowedRepos(env.ALLOWED_REPOS);

  return {
    model: task.model || defaultModel,
    cwd: checkoutPathForTask(task),
    repo: task.repo,
    baseBranch: task.branch,
    featureBranch: targetBranchForTask(task.id, task),
    allowedRepos,
  };
}

function parseAllowedRepos(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
