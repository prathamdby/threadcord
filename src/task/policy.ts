import type { AppConfig } from "../config.js";
import type { TaskRequest } from "../types.js";

export type PolicyResult = { ok: true } | { ok: false; reason: string };

export function validateTaskPolicy(
  request: TaskRequest,
  config: AppConfig,
): PolicyResult {
  if (!matchesAny(request.repo, config.allowedRepos)) {
    return { ok: false, reason: `Repo ${request.repo} is not allowed.` };
  }
  if (!config.allowedModels.includes(request.model)) {
    return { ok: false, reason: `Model ${request.model} is not allowed.` };
  }
  if (
    request.pushOverride &&
    !isExplicitPushBranchAllowed(request.pushOverride, request.branch)
  ) {
    return {
      ok: false,
      reason: `Push override ${request.pushOverride} is not allowed for branch ${request.branch}.`,
    };
  }
  return { ok: true };
}

export function targetBranchForTask(
  taskId: string,
  request: TaskRequest,
): string {
  return request.pushOverride ?? `agent/${taskId}`;
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/*")) return value.startsWith(pattern.slice(0, -1));
    return value === pattern;
  });
}

export function assertRepoAllowed(repo: string, allowedRepos: string[]): void {
  if (!matchesAny(repo, allowedRepos)) {
    throw new Error(`Repo ${repo} is not allowed.`);
  }
}

function isExplicitPushBranchAllowed(
  push: string,
  baseBranch: string,
): boolean {
  if (push.startsWith("agent/")) return true;
  return push === baseBranch;
}
