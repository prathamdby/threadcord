import { describe, expect, it } from "vitest";
import {
  parseRepositoryIdentifier,
  targetBranchForTask,
  validateBranchRef,
  validateTaskPolicy,
} from "../src/task/policy.js";
import type { AppConfig } from "../src/config.js";
import type { TaskRequest } from "../src/types.js";

const baseRequest: TaskRequest = {
  instruction: "Fix it",
  repo: "acme/web",
  branch: "main",
  model: "anthropic/claude-sonnet-4-5",
};

const config: AppConfig = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "token",
  DISCORD_CHANNEL_ID: "channel",
  GITHUB_TOKEN: "github",
  WORKSPACE_ROOT: "/workspaces",
  MAX_CONCURRENT_TASKS: 3,
  PORT: 3583,
  WORKSPACE_TTL_DAYS: 14,
  ANTHROPIC_API_KEY: "anthropic-key",
  anthropicModels: ["claude-sonnet-4-5"],
  openaiModels: [],
  customProviders: [],
  allowedModels: ["anthropic/claude-sonnet-4-5"],
  defaultModel: "anthropic/claude-sonnet-4-5",
};

// ---------------------------------------------------------------------------
// parseRepositoryIdentifier
// ---------------------------------------------------------------------------

describe("parseRepositoryIdentifier", () => {
  it("parses a valid owner/repo pair", () => {
    expect(parseRepositoryIdentifier("acme/web")).toEqual({
      ok: true,
      repo: { owner: "acme", name: "web" },
    });
  });

  it("accepts hyphens, underscores, and dots in owner and name", () => {
    expect(parseRepositoryIdentifier("my-org_123/app.service")).toEqual({
      ok: true,
      repo: { owner: "my-org_123", name: "app.service" },
    });
  });

  it("accepts a single-letter owner and name", () => {
    expect(parseRepositoryIdentifier("a/b")).toEqual({
      ok: true,
      repo: { owner: "a", name: "b" },
    });
  });

  it("rejects an empty string", () => {
    const result = parseRepositoryIdentifier("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty");
  });

  it("rejects a string with no slash", () => {
    const result = parseRepositoryIdentifier("invalid-repo-format");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Expected 'owner/repo'");
    }
  });

  it("rejects a string with multiple slashes", () => {
    const result = parseRepositoryIdentifier("a/b/c");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("single");
    }
  });

  it("rejects whitespace in the identifier", () => {
    const result = parseRepositoryIdentifier("ac me/web");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("whitespace");
  });

  it("rejects leading slash", () => {
    const result = parseRepositoryIdentifier("/acme/web");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("single");
  });

  it("rejects trailing slash", () => {
    const result = parseRepositoryIdentifier("acme/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty");
  });

  it("rejects a dot-only owner", () => {
    const result = parseRepositoryIdentifier("./repo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("traversal");
  });

  it("rejects a dot-only name", () => {
    const result = parseRepositoryIdentifier("owner/.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("traversal");
  });

  it("rejects a double-dot owner", () => {
    const result = parseRepositoryIdentifier("../repo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("traversal");
  });

  it("rejects an owner starting with a hyphen", () => {
    const result = parseRepositoryIdentifier("-acme/web");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Owner must start");
  });

  it("rejects an owner starting with a dot", () => {
    const result = parseRepositoryIdentifier(".acme/web");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Owner must start");
  });

  it("rejects a name consisting only of periods", () => {
    const result = parseRepositoryIdentifier("owner/...");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("only of periods");
  });

  it("rejects control characters", () => {
    const result = parseRepositoryIdentifier("acme\n/web");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("whitespace");
  });
});

// ---------------------------------------------------------------------------
// validateBranchRef
// ---------------------------------------------------------------------------

describe("validateBranchRef", () => {
  it("accepts a simple branch name", () => {
    expect(validateBranchRef("main")).toEqual({ ok: true, ref: "main" });
  });

  it("accepts a nested branch name", () => {
    expect(validateBranchRef("feature/my-feature")).toEqual({
      ok: true,
      ref: "feature/my-feature",
    });
  });

  it("accepts a branch with hyphens and underscores", () => {
    expect(validateBranchRef("fix_issue-123")).toEqual({
      ok: true,
      ref: "fix_issue-123",
    });
  });

  it("accepts the agent-owned namespace", () => {
    expect(validateBranchRef("agent/task-abc")).toEqual({
      ok: true,
      ref: "agent/task-abc",
    });
  });

  it("rejects an empty string", () => {
    const result = validateBranchRef("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty");
  });

  it("rejects whitespace-only", () => {
    const result = validateBranchRef("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty");
  });

  it("rejects leading whitespace", () => {
    const result = validateBranchRef(" main");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("whitespace");
  });

  it("rejects trailing whitespace", () => {
    const result = validateBranchRef("main ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("whitespace");
  });

  it("rejects control characters", () => {
    const result = validateBranchRef("main\x00branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("control");
  });

  it("rejects option-like name starting with dash", () => {
    const result = validateBranchRef("-production");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'-'");
  });

  it("rejects option-like in nested component", () => {
    const result = validateBranchRef("feature/-my-thing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'-'");
  });

  it("rejects path traversal with double dot", () => {
    const result = validateBranchRef("safe/../escape");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'..'");
  });

  it("rejects a leading slash", () => {
    const result = validateBranchRef("/main");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("slash");
  });

  it("rejects a trailing slash", () => {
    const result = validateBranchRef("main/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("slash");
  });

  it("rejects a trailing dot", () => {
    const result = validateBranchRef("main.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("dot");
  });

  it("rejects consecutive slashes", () => {
    const result = validateBranchRef("feature//my-thing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty");
  });

  it("rejects a component ending with .lock", () => {
    const result = validateBranchRef("main.lock");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(".lock");
  });

  it("rejects a nested component ending with .lock", () => {
    const result = validateBranchRef("feature/head.lock");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(".lock");
  });

  it("rejects a component starting with a dot", () => {
    const result = validateBranchRef(".hidden");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'.'");
  });

  it("rejects a nested component starting with a dot", () => {
    const result = validateBranchRef("feature/.hidden");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'.'");
  });

  it("rejects @{ syntax", () => {
    const result = validateBranchRef("branch@{1}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'@{'");
  });

  it("rejects space in branch name", () => {
    const result = validateBranchRef("my branch");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid");
  });

  it("rejects tilde", () => {
    const result = validateBranchRef("feature~1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid");
  });

  it("rejects caret", () => {
    const result = validateBranchRef("feature^");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid");
  });

  it("rejects colon", () => {
    const result = validateBranchRef("feature:test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid");
  });

  it("rejects question mark", () => {
    const result = validateBranchRef("feature?");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid");
  });

  it("rejects asterisk", () => {
    const result = validateBranchRef("feature/*");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid");
  });

  it("rejects left bracket", () => {
    const result = validateBranchRef("feature[1]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid");
  });

  it("rejects backslash", () => {
    const result = validateBranchRef("feature\\test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid");
  });
});

// ---------------------------------------------------------------------------
// validateTaskPolicy
// ---------------------------------------------------------------------------

describe("validateTaskPolicy", () => {
  it("allows a valid request", () => {
    expect(validateTaskPolicy(baseRequest, config)).toEqual({ ok: true });
  });

  it("rejects invalid repository formats (no slash)", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, repo: "invalid-repo-format" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Invalid repository format: invalid-repo-format. Expected 'owner/repo'.",
    });
  });

  it("rejects repository with whitespace", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, repo: "ac me/web" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Repository identifier must not contain whitespace.",
    });
  });

  it("rejects repository with path-traversal owner", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, repo: "../web" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Invalid repository name: ../web. Path-traversal segments are not allowed.",
    });
  });

  it("rejects models outside the allowlist", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, model: "openai/gpt-5" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Model openai/gpt-5 is not allowed.",
    });
  });

  it("rejects an invalid base branch", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, branch: "-starts-with-dash" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Invalid branch: Branch ref component must not start with '-'.",
    });
  });

  it("rejects an empty base branch", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, branch: "" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Invalid branch: Branch ref must not be empty.",
    });
  });

  it("rejects a base branch with trailing whitespace", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, branch: "main " },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Invalid branch: Branch ref must not start or end with whitespace.",
    });
  });

  it("allows pushing back to the task base branch", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "main" },
      config,
    );

    expect(result).toEqual({ ok: true });
  });

  it("allows pushing to an agent branch namespace", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "agent/task-1" },
      config,
    );

    expect(result).toEqual({ ok: true });
  });

  it("rejects push overrides to arbitrary branches", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "production" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Push override production is not allowed for branch main.",
    });
  });

  it("rejects push override with invalid branch ref", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "-invalid" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Invalid push override: Branch ref component must not start with '-'.",
    });
  });
});

// ---------------------------------------------------------------------------
// targetBranchForTask
// ---------------------------------------------------------------------------

describe("targetBranchForTask", () => {
  it("defaults to an isolated agent branch per task", () => {
    expect(targetBranchForTask("task-abc", baseRequest)).toBe("agent/task-abc");
  });

  it("honors an explicit push override", () => {
    expect(
      targetBranchForTask("task-abc", { ...baseRequest, pushOverride: "main" }),
    ).toBe("main");
  });
});
