import { getModels } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveTaskRequest } from "../src/config.js";
import { loadConfigBaseEnv } from "./support/pi-config-harness.js";

describe("loadConfig", () => {
  it("derives allowed models from Pi API keys and DEFAULT_MODEL", () => {
    const config = loadConfig(loadConfigBaseEnv);

    const anthropicModels = getModels("anthropic").map(
      (model) => `anthropic/${model.id}`,
    );
    expect(config.allowedModels).toEqual(
      expect.arrayContaining(anthropicModels),
    );
    expect(config.defaultModel).toBe("anthropic/claude-sonnet-4-5");
  });

  it("uses DEFAULT_MODEL when set", () => {
    const config = loadConfig({
      ...loadConfigBaseEnv,
      DEFAULT_MODEL: "openai/gpt-5-codex",
      OPENAI_API_KEY: "openai",
    });

    expect(config.defaultModel).toBe("openai/gpt-5-codex");
  });

  it("resolves missing model to defaultModel", () => {
    const config = loadConfig(loadConfigBaseEnv);
    const request = resolveTaskRequest(
      {
        instruction: "Fix it",
        repo: "owner/repo",
        branch: "main",
      },
      config,
    );

    expect(request.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("parses inline PI_MODELS_JSON", () => {
    const config = loadConfig({
      ...loadConfigBaseEnv,
      PI_MODELS_JSON: JSON.stringify({
        providers: { anthropic: { baseUrl: "https://proxy/v1" } },
      }),
    });

    expect(config.modelsJson?.providers.anthropic?.baseUrl).toBe(
      "https://proxy/v1",
    );
  });

  it("requires at least one configured Pi provider", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://example",
        DISCORD_BOT_TOKEN: "discord",
        GITHUB_TOKEN: "github",
      }),
    ).toThrow(/At least one Pi provider must be configured/);
  });

  it("defaults AGENT_MAX_VALIDATION_FAILURES to 3", () => {
    const config = loadConfig(loadConfigBaseEnv);
    expect(config.AGENT_MAX_VALIDATION_FAILURES).toBe(3);
  });

  it("defaults AgentOS config vars", () => {
    const config = loadConfig(loadConfigBaseEnv);
    expect(config.MAX_ACTIVE_VMS).toBe(2);
    expect(config.RESERVED_SYSTEM_MEMORY_MB).toBe(4096);
    expect(config.MIN_FREE_DISK_MB).toBe(2048);
    expect(config.AGENTOS_SANDBOX_ENABLE).toBe(false);
    expect(config.RUNTIME_LOG_LEVEL).toBe("info");
    expect(config.TURN_TIMEOUT_MS).toBe(3600000);
    expect(config.TURN_HEARTBEAT_TIMEOUT_MS).toBe(120000);
    expect(config.SETUP_INSTALL_TIMEOUT_MS).toBe(1800000);
    expect(config.AGENTOS_SIDECAR_BIN).toBeUndefined();
  });
});
