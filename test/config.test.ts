import { describe, expect, it } from "vitest";
import { loadConfig, resolveTaskRequest } from "../src/config.js";

const baseEnv = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "discord",
  DISCORD_CHANNEL_ID: "channel",
  GITHUB_TOKEN: "github",
  ANTHROPIC_API_KEY: "anthropic",
  ANTHROPIC_MODELS: "claude-sonnet-4-5",
};

describe("loadConfig", () => {
  it("treats empty THREADCORD_HTTP_BEARER as unset outside production", () => {
    const config = loadConfig({
      ...baseEnv,
      THREADCORD_HTTP_BEARER: "",
    });

    expect(config.THREADCORD_HTTP_BEARER).toBeUndefined();
  });

  it("requires THREADCORD_HTTP_BEARER when NODE_ENV is production", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
        THREADCORD_HTTP_BEARER: "",
      }),
    ).toThrow(/THREADCORD_HTTP_BEARER/);
  });

  it("rejects a missing THREADCORD_HTTP_BEARER in production", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
      }),
    ).toThrow(/THREADCORD_HTTP_BEARER/);
  });

  it("rejects the development default THREADCORD_HTTP_BEARER in production", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
        THREADCORD_HTTP_BEARER: "threadcord-dev-bearer",
      }),
    ).toThrow(/THREADCORD_HTTP_BEARER/);
  });

  it("rejects a cased variant of the development default in production", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
        THREADCORD_HTTP_BEARER: "Threadcord-Dev-Bearer",
      }),
    ).toThrow(/THREADCORD_HTTP_BEARER/);
  });

  it("rejects non-standard NODE_ENV values so the runtime agrees on the mode", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: "  Production  ",
      }),
    ).toThrow(/NODE_ENV/);
  });

  it("rejects a trivially short THREADCORD_HTTP_BEARER in production", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
        THREADCORD_HTTP_BEARER: "short-token",
      }),
    ).toThrow(/THREADCORD_HTTP_BEARER/);
  });

  it("accepts THREADCORD_HTTP_BEARER in production", () => {
    const config = loadConfig({
      ...baseEnv,
      NODE_ENV: "production",
      THREADCORD_HTTP_BEARER: "prod-bearer-0123456789abcdef",
    });

    expect(config.THREADCORD_HTTP_BEARER).toBe("prod-bearer-0123456789abcdef");
  });

  it("stores the trimmed THREADCORD_HTTP_BEARER so validation and auth agree", () => {
    const config = loadConfig({
      ...baseEnv,
      NODE_ENV: "production",
      THREADCORD_HTTP_BEARER: "  prod-bearer-0123456789abcdef  ",
    });

    expect(config.THREADCORD_HTTP_BEARER).toBe("prod-bearer-0123456789abcdef");
  });

  it("accepts the development default THREADCORD_HTTP_BEARER outside production", () => {
    const config = loadConfig({
      ...baseEnv,
      THREADCORD_HTTP_BEARER: "threadcord-dev-bearer",
    });

    expect(config.THREADCORD_HTTP_BEARER).toBe("threadcord-dev-bearer");
  });

  it("derives allowedModels from built-in anthropic config", () => {
    const config = loadConfig(baseEnv);

    expect(config.allowedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(config.defaultModel).toBe("anthropic/claude-sonnet-4-5");
    expect(config.anthropicModels).toEqual(["claude-sonnet-4-5"]);
    expect(config.customProviders).toEqual([]);
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
      PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
    });

    expect(config.customProviders).toEqual([
      {
        id: "ollama",
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        models: ["llama3.1:8b"],
      },
    ]);
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

    expect(config.customProviders).toEqual([]);
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

  it("requires at least one configured provider model", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://example",
        DISCORD_BOT_TOKEN: "discord",
        DISCORD_CHANNEL_ID: "channel",
        GITHUB_TOKEN: "github",
      }),
    ).toThrow(/At least one provider model must be configured/);
  });
});
