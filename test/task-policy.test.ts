import { describe, expect, it } from "vitest";
import { validateTaskPolicy } from "../src/task/policy.js";
import type { AppConfig } from "../src/config.js";
import { anthropicPiConfig } from "./support/pi-config-harness.js";
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

  GITHUB_TOKEN: "github",
  WORKSPACE_ROOT: "/workspaces",
  MAX_CONCURRENT_TASKS: 3,
  AGENT_MAX_TOOL_FAILURES: 10,
  AGENT_MAX_VALIDATION_FAILURES: 3,
  PORT: 3583,
  WORKSPACE_TTL_DAYS: 14,
  MAX_ACTIVE_VMS: 2,
  RESERVED_SYSTEM_MEMORY_MB: 4096,
  MIN_FREE_DISK_MB: 2048,
  AGENTOS_SIDECAR_BIN: undefined,
  AGENTOS_SANDBOX_ENABLE: false,
  RUNTIME_LOG_LEVEL: "info",
  TURN_TIMEOUT_MS: 3600000,
  TURN_HEARTBEAT_TIMEOUT_MS: 120000,
  SETUP_INSTALL_TIMEOUT_MS: 1800000,
  ANTHROPIC_API_KEY: "anthropic-key",
  ...anthropicPiConfig({
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
  }),
};

describe("validateTaskPolicy", () => {
  it("allows a valid request", () => {
    expect(validateTaskPolicy(baseRequest, config)).toEqual({ ok: true });
  });

  it("rejects invalid repository formats", () => {
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

  it("rejects unsafe branch names before setup lookup", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, branch: "../main" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Invalid branch name: ../main.",
    });
  });

  it("allows pushing back to the task base branch", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "main" },
      config,
    );

    expect(result).toEqual({ ok: true });
  });

  it("allows pushing to a threadcord branch namespace", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "threadcord/chore/task-1" },
      config,
    );

    expect(result).toEqual({ ok: true });
  });

  it("rejects bare threadcord branch namespace push overrides", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "threadcord/" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Push override threadcord/ is not allowed for branch main.",
    });
  });

  it("rejects agent branch namespace push overrides", () => {
    const result = validateTaskPolicy(
      { ...baseRequest, pushOverride: "agent/task-1" },
      config,
    );

    expect(result).toEqual({
      ok: false,
      reason: "Push override agent/task-1 is not allowed for branch main.",
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
});
