import { describe, expect, it } from "vitest";
import {
  targetBranchForTask,
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

describe("validateTaskPolicy", () => {
  it("allows a valid request", () => {
    expect(validateTaskPolicy(baseRequest, config)).toEqual({
      ok: true,
      request: baseRequest,
    });
  });

  it("normalizes accepted repository names", () => {
    expect(
      validateTaskPolicy({ ...baseRequest, repo: "Acme/Web.UI" }, config),
    ).toEqual({
      ok: true,
      request: { ...baseRequest, repo: "acme/web.ui" },
    });
  });

  it("allows safe branch namespaces", () => {
    expect(
      validateTaskPolicy(
        { ...baseRequest, branch: "release/v1.2.3" },
        config,
      ),
    ).toEqual({
      ok: true,
      request: { ...baseRequest, branch: "release/v1.2.3" },
    });
  });

  it("rejects invalid repository formats", () => {
    const invalidRepos = [
      "invalid-repo-format",
      "acme/",
      "/web",
      "acme/web/extra",
      "acme//web",
      "acme/..",
      "../web",
      "bad owner/web",
      "bad_owner/web",
      "-bad/web",
      "bad-/web",
      "bad--owner/web",
      "acme/web repo",
    ];

    for (const repo of invalidRepos) {
      expect(validateTaskPolicy({ ...baseRequest, repo }, config)).toEqual({
        ok: false,
        reason: `Invalid repository format: ${repo}. Expected 'owner/repo'.`,
      });
    }
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

  it("allows pushing back to the task base branch", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "main" },
      config,
    );

    expect(result).toEqual({
      ok: true,
      request: { ...baseRequest, pushOverride: "main" },
    });
  });

  it("allows pushing to an agent branch namespace", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "agent/task-1" },
      config,
    );

    expect(result).toEqual({
      ok: true,
      request: { ...baseRequest, pushOverride: "agent/task-1" },
    });
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

  it("rejects unsafe base branch names", () => {
    const invalidBranches = [
      "",
      " ",
      "-main",
      "../main",
      "feature/../main",
      "feature//main",
      "main.lock",
      "feature/main.lock",
      "main.",
      "feature~main",
      "feature^main",
      "feature:main",
      "feature?main",
      "feature*main",
      "feature[main",
      "feature\\main",
      "feature@{1}",
      "@",
      "HEAD",
      "refs/heads/main",
      "pull/1/head",
    ];

    for (const branch of invalidBranches) {
      expect(validateTaskPolicy({ ...baseRequest, branch }, config)).toEqual({
        ok: false,
        reason: `Invalid branch format: ${branch}. Expected a branch name like 'main' or 'agent/task-1'.`,
      });
    }
  });

  it("rejects unsafe push override names before product policy", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "-main" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Invalid push override format: -main. Expected a branch name like 'main' or 'agent/task-1'.",
    });
  });
});

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
