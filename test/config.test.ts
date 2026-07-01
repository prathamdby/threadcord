import { describe, expect, it } from "vitest";
import { loadConfig, resolveTaskRequest } from "../src/config.js";

const baseEnv = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "discord",
  GITHUB_TOKEN: "github",
  ANTHROPIC_API_KEY: "anthropic",
  ANTHROPIC_MODELS: "claude-sonnet-4-5",
};

describe("loadConfig", () => {
  it("derives allowedModels from built-in anthropic config", () => {
    const config = loadConfig(baseEnv);

    expect(config.allowedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(config.defaultModel).toBe("anthropic/claude-sonnet-4-5");
    expect(config.providerRegistry.providers[0]?.id).toBe("anthropic");
  });

  it("uses the first derived model as defaultModel", () => {
    const config = loadConfig({
      ...baseEnv,
      OPENAI_API_KEY: "openai",
      OPENAI_MODELS: "gpt-5-codex",
    });

    expect(config.defaultModel).toBe("anthropic/claude-sonnet-4-5");
    expect(config.allowedModels[0]).toBe(config.defaultModel);
  });

  it("resolves missing model to defaultModel", () => {
    const config = loadConfig(baseEnv);
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

  it("parses a custom provider from PROVIDERS and prefixed env vars", () => {
    const config = loadConfig({
      ...baseEnv,
      PROVIDERS: "ollama",
      PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
      PROVIDER_OLLAMA_API: "openai-completions",
      PROVIDER_OLLAMA_HEADERS: '{"User-Agent":"Threadcord"}',
      PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
    });

    expect(config.providerRegistry.providers[1]).toMatchObject({
      id: "ollama",
      models: ["llama3.1:8b"],
      transport: {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        headers: { "User-Agent": "Threadcord" },
      },
    });
    expect(config.allowedModels).toEqual([
      "anthropic/claude-sonnet-4-5",
      "ollama/llama3.1:8b",
    ]);
  });

  it("requires PROVIDER_*_BASE_URL for custom providers", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        PROVIDERS: "ollama",
        PROVIDER_OLLAMA_API: "openai-completions",
        PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
      }),
    ).toThrow(/PROVIDER_OLLAMA_BASE_URL/);
  });

  it("requires PROVIDER_*_API for custom providers", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        PROVIDERS: "ollama",
        PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
        PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
      }),
    ).toThrow(/PROVIDER_OLLAMA_API/);
  });

  it("requires ANTHROPIC_API_KEY when ANTHROPIC_MODELS is set", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODELS: "claude-sonnet-4-5",
        PROVIDERS: "ollama",
        PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
        PROVIDER_OLLAMA_API: "openai-completions",
        PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
      }),
    ).toThrow(/ANTHROPIC_API_KEY is required when ANTHROPIC_MODELS is set/);
  });

  it("requires ANTHROPIC_MODELS when ANTHROPIC_API_KEY is set", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        ANTHROPIC_MODELS: "",
      }),
    ).toThrow(/ANTHROPIC_MODELS is required when ANTHROPIC_API_KEY is set/);
  });

  it("allows empty PROVIDERS when a built-in provider is configured", () => {
    const config = loadConfig({
      ...baseEnv,
      PROVIDERS: "",
    });

    expect(config.allowedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
  });

  it("dedupes allowedModels from overlapping sources", () => {
    const config = loadConfig({
      ...baseEnv,
      PROVIDERS: "anthropic",
      PROVIDER_ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
      PROVIDER_ANTHROPIC_API: "anthropic-messages",
      PROVIDER_ANTHROPIC_MODELS: "claude-sonnet-4-5",
    });

    expect(config.allowedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
  });

  it("rejects invalid provider ids", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        PROVIDERS: "Ollama",
      }),
    ).toThrow(/Invalid provider id/);
  });

  it("defaults AGENT_MAX_VALIDATION_FAILURES to 3", () => {
    const config = loadConfig(baseEnv);
    expect(config.AGENT_MAX_VALIDATION_FAILURES).toBe(3);
  });

  it("accepts a custom AGENT_MAX_VALIDATION_FAILURES", () => {
    const config = loadConfig({
      ...baseEnv,
      AGENT_MAX_VALIDATION_FAILURES: "5",
    });
    expect(config.AGENT_MAX_VALIDATION_FAILURES).toBe(5);
  });

  it("requires at least one configured provider model", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://example",
        DISCORD_BOT_TOKEN: "discord",
        GITHUB_TOKEN: "github",
      }),
    ).toThrow(/At least one provider model must be configured/);
  });

  it("defaults AgentOS config vars", () => {
    const config = loadConfig(baseEnv);
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

  it("accepts custom AgentOS config vars", () => {
    const config = loadConfig({
      ...baseEnv,
      MAX_ACTIVE_VMS: "4",
      RESERVED_SYSTEM_MEMORY_MB: "8192",
      MIN_FREE_DISK_MB: "4096",
      AGENTOS_SIDECAR_BIN: "/opt/agentos-sidecar",
      AGENTOS_SANDBOX_ENABLE: "true",
      RUNTIME_LOG_LEVEL: "debug",
      TURN_TIMEOUT_MS: "7200000",
      TURN_HEARTBEAT_TIMEOUT_MS: "300000",
      SETUP_INSTALL_TIMEOUT_MS: "3600000",
    });
    expect(config.MAX_ACTIVE_VMS).toBe(4);
    expect(config.RESERVED_SYSTEM_MEMORY_MB).toBe(8192);
    expect(config.MIN_FREE_DISK_MB).toBe(4096);
    expect(config.AGENTOS_SIDECAR_BIN).toBe("/opt/agentos-sidecar");
    expect(config.AGENTOS_SANDBOX_ENABLE).toBe(true);
    expect(config.RUNTIME_LOG_LEVEL).toBe("debug");
    expect(config.TURN_TIMEOUT_MS).toBe(7200000);
    expect(config.TURN_HEARTBEAT_TIMEOUT_MS).toBe(300000);
    expect(config.SETUP_INSTALL_TIMEOUT_MS).toBe(3600000);
  });

  it("rejects custom provider APIs not supported by Pi", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        PROVIDERS: "unsupported",
        PROVIDER_UNSUPPORTED_BASE_URL: "http://localhost:11434/v1",
        PROVIDER_UNSUPPORTED_API: "unsupported-api",
        PROVIDER_UNSUPPORTED_MODELS: "model-1",
      }),
    ).toThrow(
      /PROVIDER_UNSUPPORTED_API must be one of openai-completions, openai-responses, anthropic-messages/,
    );
  });
});
