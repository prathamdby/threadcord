import type { AppConfig } from "../config.js";
import type { TaskRequest } from "../types.js";

export type PolicyResult = { ok: true } | { ok: false; reason: string };

const REPO_FORMAT = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function validateTaskPolicy(
  request: TaskRequest,
  config: AppConfig,
): PolicyResult {
  if (!REPO_FORMAT.test(request.repo)) {
    return {
      ok: false,
      reason: `Invalid repository format: ${request.repo}. Expected 'owner/repo'.`,
    };
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

function isExplicitPushBranchAllowed(
  push: string,
  baseBranch: string,
): boolean {
  if (push.startsWith("agent/")) return true;
  return push === baseBranch;
}
