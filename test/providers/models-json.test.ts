import { describe, expect, it } from "vitest";
import { buildModelsJson, loadProviderRegistry } from "../../src/providers/index.js";

describe("buildModelsJson", () => {
  it("returns null for built-in anthropic without transport overrides", () => {
    const registry = loadProviderRegistry({
      anthropicApiKey: "key",
      anthropicModels: "claude-sonnet-4-5",
    });

    expect(buildModelsJson(registry)).toBeNull();
  });

  it("writes override-only built-in anthropic proxy entries", () => {
    const registry = loadProviderRegistry({
      anthropicApiKey: "key",
      anthropicModels: "claude-sonnet-4-5",
      providersCsv: "anthropic",
      env: {
        PROVIDER_ANTHROPIC_BASE_URL: "https://proxy/v1",
      },
    });

    expect(buildModelsJson(registry)).toEqual({
      providers: {
        anthropic: {
          baseUrl: "https://proxy/v1",
        },
      },
    });
  });

  it("includes headers on built-in override entries", () => {
    const registry = loadProviderRegistry({
      anthropicApiKey: "key",
      anthropicModels: "claude-sonnet-4-5",
      providersCsv: "anthropic",
      env: {
        PROVIDER_ANTHROPIC_BASE_URL: "https://proxy/v1",
        PROVIDER_ANTHROPIC_HEADERS: '{"User-Agent":"Threadcord"}',
      },
    });

    expect(buildModelsJson(registry)).toEqual({
      providers: {
        anthropic: {
          baseUrl: "https://proxy/v1",
          headers: { "User-Agent": "Threadcord" },
        },
      },
    });
  });

  it("writes full custom provider entries with env apiKey names", () => {
    const registry = loadProviderRegistry({
      providersCsv: "ollama",
      env: {
        PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
        PROVIDER_OLLAMA_API: "openai-completions",
        PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
      },
    });

    expect(buildModelsJson(registry)).toEqual({
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          apiKey: "OLLAMA_API_KEY",
          models: [{ id: "llama3.1:8b" }],
        },
      },
    });
  });

  it("writes override entries for built-in opencode-go transport", () => {
    const registry = loadProviderRegistry({
      providersCsv: "opencode-go",
      env: {
        PROVIDER_OPENCODE_GO_BASE_URL: "https://opencode.ai/zen/go/v1",
        PROVIDER_OPENCODE_GO_API: "openai-completions",
        PROVIDER_OPENCODE_GO_MODELS: "deepseek-v4-flash",
        PROVIDER_OPENCODE_GO_API_KEY: "secret",
      },
    });

    expect(buildModelsJson(registry)?.providers["opencode-go"]).toMatchObject({
      baseUrl: "https://opencode.ai/zen/go/v1",
      api: "openai-completions",
    });
  });

  it("uses null-prototype header objects", () => {
    const registry = loadProviderRegistry({
      providersCsv: "agent-router",
      env: {
        PROVIDER_AGENT_ROUTER_BASE_URL: "https://router.example.com/v1",
        PROVIDER_AGENT_ROUTER_API: "openai-completions",
        PROVIDER_AGENT_ROUTER_HEADERS:
          '{"User-Agent":"Threadcord","__proto__":"ignored"}',
        PROVIDER_AGENT_ROUTER_MODELS: "gpt-5-codex",
      },
    });

    const headers = buildModelsJson(registry)?.providers["agent-router"]
      ?.headers;
    expect(Object.getPrototypeOf(headers)).toBeNull();
  });
});
