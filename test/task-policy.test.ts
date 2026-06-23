import { describe, expect, it } from "vitest";
import {
  assertRepoAllowed,
  matchesAny,
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
  ALLOWED_REPOS: "acme/*",
  PORT: 3583,
  WORKSPACE_TTL_DAYS: 14,
  ANTHROPIC_API_KEY: "anthropic-key",
  allowedRepos: ["acme/*"],
  anthropicModels: ["claude-sonnet-4-5"],
  openaiModels: [],
  customProviders: [],
  allowedModels: ["anthropic/claude-sonnet-4-5"],
  defaultModel: "anthropic/claude-sonnet-4-5",
};

describe("validateTaskPolicy", () => {
  it("allows repos under an owner glob", () => {
    expect(validateTaskPolicy(baseRequest, config)).toEqual({ ok: true });
  });

  it("rejects repos outside the allowlist", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, repo: "other/web" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Repo other/web is not allowed.",
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

describe("assertRepoAllowed", () => {
  it("rejects repos outside the allowlist", () => {
    expect(() => assertRepoAllowed("other/web", config.allowedRepos)).toThrow(
      /not allowed/,
    );
  });

  it("accepts repos under an owner glob", () => {
    expect(() =>
      assertRepoAllowed("acme/web", config.allowedRepos),
    ).not.toThrow();
  });
});

describe("matchesAny", () => {
  it("matches owner globs", () => {
    expect(matchesAny("acme/web", ["acme/*"])).toBe(true);
    expect(matchesAny("other/web", ["acme/*"])).toBe(false);
  });
});
