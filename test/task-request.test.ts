import { describe, expect, it } from "vitest";
import { loadConfig, resolveTaskRequest } from "../src/config.js";
import { parseTaskMessage } from "../src/task/parser.js";
import { validateTaskPolicy } from "../src/task/policy.js";

const env = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "discord",
  DISCORD_CHANNEL_ID: "channel",
  GITHUB_TOKEN: "github",
  ANTHROPIC_API_KEY: "anthropic",
  ANTHROPIC_MODELS: "claude-sonnet-4-5,claude-opus-4-1",
  OPENAI_API_KEY: "openai",
  OPENAI_MODELS: "gpt-5-codex",
};

describe("task request resolution", () => {
  it("preserves an explicit model from the Discord message", () => {
    const config = loadConfig(env);
    const parsed = parseTaskMessage(
      [
        "Fix the auth test.",
        "repo: acme/web",
        "branch: main",
        "model: openai/gpt-5-codex",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const request = resolveTaskRequest(parsed.request, config);
    expect(request.model).toBe("openai/gpt-5-codex");
  });

  it("fills a missing model from the first configured provider model", () => {
    const config = loadConfig(env);
    const parsed = parseTaskMessage(
      ["Fix the auth test.", "repo: acme/web", "branch: main"].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const request = resolveTaskRequest(parsed.request, config);
    expect(request.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("allows a model-less Discord task after default resolution", () => {
    const config = loadConfig(env);
    const parsed = parseTaskMessage(
      ["Fix the auth test.", "repo: acme/web", "branch: main"].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const request = resolveTaskRequest(parsed.request, config);
    expect(validateTaskPolicy(request, config)).toEqual({
      ok: true,
      request,
    });
  });

  it("rejects an explicit model outside the derived allowlist", () => {
    const config = loadConfig(env);
    const parsed = parseTaskMessage(
      [
        "Fix the auth test.",
        "repo: acme/web",
        "branch: main",
        "model: anthropic/claude-unknown",
      ].join("\n"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const request = resolveTaskRequest(parsed.request, config);
    expect(validateTaskPolicy(request, config)).toEqual({
      ok: false,
      reason: "Model anthropic/claude-unknown is not allowed.",
    });
  });
});
