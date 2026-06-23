import type { AppConfig } from "../config.js";
import type { TaskRequest } from "../types.js";

export type PolicyResult = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Repository identifier parsing
// ---------------------------------------------------------------------------

export interface ParsedRepository {
  owner: string;
  name: string;
}

export type ParseRepoResult =
  | { ok: true; repo: ParsedRepository }
  | { ok: false; reason: string };

/**
 * Parse and validate a GitHub repository identifier in the form `owner/name`.
 *
 * Rules (derived from GitHub naming conventions and safety concerns):
 *  - Must contain exactly one `/` separator.
 *  - Neither segment may be empty.
 *  - No whitespace, control characters, or path-traversal segments (`.` / `..`).
 *  - Each segment must match allowed GitHub characters:
 *    alphanumeric, hyphens, underscores, and periods.
 *  - The owner segment must start with an alphanumeric character.
 *  - The name segment must start with an alphanumeric character or period.
 */
export function parseRepositoryIdentifier(
  input: string,
): ParseRepoResult {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, reason: "Repository identifier must not be empty." };
  }

  // No whitespace anywhere
  if (/[\s]/.test(input)) {
    return { ok: false, reason: "Repository identifier must not contain whitespace." };
  }

  // Split on the first slash; reject extra slashes
  const slashIndex = input.indexOf("/");
  if (slashIndex === -1) {
    return {
      ok: false,
      reason: `Invalid repository format: ${input}. Expected 'owner/repo'.`,
    };
  }
  if (slashIndex !== input.lastIndexOf("/")) {
    return {
      ok: false,
      reason: `Invalid repository format: ${input}. Expected a single 'owner/repo' pair.`,
    };
  }

  const owner = input.slice(0, slashIndex);
  const name = input.slice(slashIndex + 1);

  if (owner.length === 0 || name.length === 0) {
    return {
      ok: false,
      reason: `Invalid repository format: ${input}. Owner and name must not be empty.`,
    };
  }

  // Reject path-traversal segments
  if (owner === "." || owner === ".." || name === "." || name === "..") {
    return {
      ok: false,
      reason: `Invalid repository name: ${input}. Path-traversal segments are not allowed.`,
    };
  }

  // Owner must start with alphanumeric (GitHub convention)
  if (!/^[a-zA-Z0-9]/.test(owner)) {
    return {
      ok: false,
      reason: `Invalid repository format: ${input}. Owner must start with a letter or number.`,
    };
  }

  // Owner: alphanumeric, hyphens, underscores, periods
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(owner)) {
    return {
      ok: false,
      reason: `Invalid repository format: ${input}. Owner contains invalid characters.`,
    };
  }

  // Name: alphanumeric, hyphens, underscores, periods (can start with period)
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return {
      ok: false,
      reason: `Invalid repository format: ${input}. Repository name contains invalid characters.`,
    };
  }

  // Reject segments that are just dots
  if (/^\.+$/.test(name)) {
    return {
      ok: false,
      reason: `Invalid repository name: ${input}. Name cannot consist only of periods.`,
    };
  }

  return { ok: true, repo: { owner, name } };
}

// ---------------------------------------------------------------------------
// Git branch reference validation
// ---------------------------------------------------------------------------

export type BranchRefResult =
  | { ok: true; ref: string }
  | { ok: false; reason: string };

/**
 * Validate a string as a safe Git branch reference name.
 *
 * Rules are derived from `git check-ref-format` and Threadcord's own safety
 * requirements:
 *  - Not empty or whitespace-only.
 *  - No leading or trailing slash, whitespace, or dot.
 *  - No consecutive slashes (empty components).
 *  - No component starting with `-` (option-like) or `.`.
 *  - No component ending with `.lock` or `.` (dot).
 *  - No `..` (path traversal).
 *  - No `@{` (Git special syntax).
 *  - No control characters, space, or characters Git treats as special:
 *    `~`, `^`, `:`, `?`, `*`, `[`, `\`.
 */
export function validateBranchRef(input: string): BranchRefResult {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, reason: "Branch ref must not be empty." };
  }

  // Reject whitespace-only and leading/trailing whitespace outright
  if (/^\s+$/.test(input)) {
    return { ok: false, reason: "Branch ref must not be whitespace-only." };
  }
  if (/^[\s]/.test(input) || /[\s]$/.test(input)) {
    return {
      ok: false,
      reason: "Branch ref must not start or end with whitespace.",
    };
  }

  const ref = input;

  // Control characters (0x00-0x1F, 0x7F DEL)
  if (/[\x00-\x1F\x7F]/.test(ref)) {
    return { ok: false, reason: "Branch ref must not contain control characters." };
  }

  // Forbidden characters: space, ~, ^, :, ?, *, [, \
  if (/[\s~^:?*\[\\]/.test(ref)) {
    return { ok: false, reason: "Branch ref contains invalid characters." };
  }

  // Leading or trailing slash
  if (ref.startsWith("/") || ref.endsWith("/")) {
    return { ok: false, reason: "Branch ref must not start or end with a slash." };
  }

  // Leading or trailing dot
  if (ref.endsWith(".")) {
    return { ok: false, reason: "Branch ref must not end with a dot." };
  }

  // Consecutive slashes (empty component)
  if (ref.includes("//")) {
    return { ok: false, reason: "Branch ref must not contain empty components." };
  }

  // Double-dot (path traversal in Git)
  if (ref.includes("..")) {
    return { ok: false, reason: "Branch ref must not contain '..'." };
  }

  // @{} sequence (special Git syntax)
  if (ref.includes("@{")) {
    return { ok: false, reason: "Branch ref must not contain '@{'." };
  }

  // Validate each slash-separated component
  const components = ref.split("/");
  for (const component of components) {
    if (component.startsWith("-")) {
      return {
        ok: false,
        reason: "Branch ref component must not start with '-'.",
      };
    }
    if (component.startsWith(".")) {
      return {
        ok: false,
        reason: "Branch ref component must not start with '.'.",
      };
    }
    if (component.endsWith(".lock")) {
      return {
        ok: false,
        reason: "Branch ref component must not end with '.lock'.",
      };
    }
  }

  return { ok: true, ref };
}

// ---------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------

export function validateTaskPolicy(
  request: TaskRequest,
  config: AppConfig,
): PolicyResult {
  // Repository validation
  const repoResult = parseRepositoryIdentifier(request.repo);
  if (!repoResult.ok) {
    return { ok: false, reason: repoResult.reason };
  }

  // Model validation
  if (!config.allowedModels.includes(request.model)) {
    return { ok: false, reason: `Model ${request.model} is not allowed.` };
  }

  // Base branch validation
  const branchResult = validateBranchRef(request.branch);
  if (!branchResult.ok) {
    return {
      ok: false,
      reason: `Invalid branch: ${branchResult.reason}`,
    };
  }

  // Push override validation (if present)
  if (request.pushOverride) {
    const pushResult = validateBranchRef(request.pushOverride);
    if (!pushResult.ok) {
      return {
        ok: false,
        reason: `Invalid push override: ${pushResult.reason}`,
      };
    }

    if (!isExplicitPushBranchAllowed(request.pushOverride, request.branch)) {
      return {
        ok: false,
        reason: `Push override ${request.pushOverride} is not allowed for branch ${request.branch}.`,
      };
    }
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
