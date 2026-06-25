import { basename, join } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { getPool } from "../db.js";
import type { SetupProfile } from "../setup/profile.js";
import { SetupStore } from "../setup/store.js";
import { TaskStore } from "./store.js";
import type { TaskRecord } from "../types.js";

export interface AgentRuntimeContext {
  model: string;
  cwd: string;
  workspaceRoot: string;
  repo: string;
  baseBranch: string;
  pushOverride?: string;
  checks: Record<string, string>;
  requiredEnv: string[];
}

export function checkoutPathForTask(task: TaskRecord): string {
  return join(task.workspacePath, basename(task.repo));
}

export function agentRuntimeContextFromTask(
  task: TaskRecord,
  config: { defaultModel: string },
  profile: SetupProfile,
): AgentRuntimeContext {
  if (
    profile.status !== "ready" &&
    profile.revision !== task.setupProfileRevision
  ) {
    throw new Error(
      `No ready setup profile for ${task.repo}@${task.branch}`,
    );
  }

  return {
    model: task.model || config.defaultModel,
    cwd: checkoutPathForTask(task),
    workspaceRoot: task.workspacePath,
    repo: task.repo,
    baseBranch: task.branch,
    ...(task.pushOverride ? { pushOverride: task.pushOverride } : {}),
    checks: profile.environment.checks,
    requiredEnv: profile.environment.requiredEnv,
  };
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

  const setupStore = new SetupStore(getPool());
  let profile = await setupStore.getReadyProfile(task.repo, task.branch);
  if (!profile) {
    const current = await setupStore.getProfile(task.repo, task.branch);
    if (current && current.revision === task.setupProfileRevision) {
      profile = current;
    }
  }
  if (!profile) {
    throw new Error(
      `No ready setup profile for ${task.repo}@${task.branch}`,
    );
  }

  return agentRuntimeContextFromTask(task, getRuntimeConfig(), profile);
}
