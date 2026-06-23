import type { AppConfig } from "../config.js";
import type { TaskRequest } from "../types.js";

export type PolicyResult =
  | { ok: true; request: TaskRequest }
  | { ok: false; reason: string };

export type RepositoryParseResult =
  | { ok: true; owner: string; name: string; fullName: string }
  | { ok: false };

const OWNER_FORMAT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_NAME_FORMAT = /^[A-Za-z0-9._-]{1,100}$/;
const PATH_SEGMENTS = new Set([".", ".."]);
const SPECIAL_REFS = new Set([
  "HEAD",
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
]);
const INVALID_BRANCH_CHARACTERS = /[\x00-\x20\x7f~^:?*[\\]/;

export function validateTaskPolicy(
  request: TaskRequest,
  config: AppConfig,
): PolicyResult {
  const repo = parseGitHubRepository(request.repo);
  if (!repo.ok) {
    return {
      ok: false,
      reason: `Invalid repository format: ${request.repo}. Expected 'owner/repo'.`,
    };
  }
  if (!isSafeBranchName(request.branch)) {
    return {
      ok: false,
      reason: `Invalid branch format: ${request.branch}. Expected a branch name like 'main' or 'agent/task-1'.`,
    };
  }
  if (!config.allowedModels.includes(request.model)) {
    return { ok: false, reason: `Model ${request.model} is not allowed.` };
  }
  if (request.pushOverride && !isSafeBranchName(request.pushOverride)) {
    return {
      ok: false,
      reason: `Invalid push override format: ${request.pushOverride}. Expected a branch name like 'main' or 'agent/task-1'.`,
    };
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
  return { ok: true, request: { ...request, repo: repo.fullName } };
}

export function targetBranchForTask(
  taskId: string,
  request: TaskRequest,
): string {
  return request.pushOverride ?? `agent/${taskId}`;
}

export function parseGitHubRepository(repo: string): RepositoryParseResult {
  const parts = repo.split("/");
  if (parts.length !== 2) return { ok: false };

  const [rawOwner, rawName] = parts;
  if (!rawOwner || !rawName) return { ok: false };
  if (PATH_SEGMENTS.has(rawOwner) || PATH_SEGMENTS.has(rawName)) {
    return { ok: false };
  }
  if (rawOwner.includes("--")) return { ok: false };
  if (!OWNER_FORMAT.test(rawOwner) || !REPO_NAME_FORMAT.test(rawName)) {
    return { ok: false };
  }

  const owner = rawOwner.toLowerCase();
  const name = rawName.toLowerCase();
  return { ok: true, owner, name, fullName: `${owner}/${name}` };
}

function isSafeBranchName(branch: string): boolean {
  if (!branch || branch.trim() !== branch) return false;
  if (INVALID_BRANCH_CHARACTERS.test(branch)) return false;
  if (branch.startsWith("-")) return false;
  if (branch.startsWith("+")) return false;
  if (branch.startsWith("/") || branch.endsWith("/")) return false;
  if (branch.startsWith("refs/") || branch.startsWith("pull/")) return false;
  if (branch.includes("//") || branch.includes("..")) return false;
  if (branch.includes("@{") || branch === "@") return false;
  if (branch.endsWith(".") || SPECIAL_REFS.has(branch)) return false;

  return branch.split("/").every((part) => {
    return part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock");
  });
}

function isExplicitPushBranchAllowed(
  push: string,
  baseBranch: string,
): boolean {
  if (push.startsWith("agent/")) return true;
  return push === baseBranch;
}
