import { basename, join } from "node:path";
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

  const defaultModel = stringEnv(
    env,
    "THREADCORD_DEFAULT_MODEL",
    "anthropic/claude-sonnet-4-5",
  );
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

function stringEnv(
  env: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseAllowedRepos(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
