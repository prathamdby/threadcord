import { describe, expect, it } from "vitest";
import {
  deriveAllowedModels,
  loadProviderRegistry,
  providerEnvPrefix,
} from "../../src/providers/index.js";
import { parseProviderBlock } from "../../src/providers/env.js";

describe("providerEnvPrefix", () => {
  it("normalizes hyphens to underscores and uppercases the provider id", () => {
    expect(providerEnvPrefix("my-gateway")).toBe("PROVIDER_MY_GATEWAY");
    expect(providerEnvPrefix("ollama")).toBe("PROVIDER_OLLAMA");
  });
});

describe("loadProviderRegistry", () => {
  it("parses anthropic sugar into the registry", () => {
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic-key",
      anthropicModels: "claude-sonnet-4-5",
    });

    expect(registry.providers).toEqual([
      {
        id: "anthropic",
        models: ["claude-sonnet-4-5"],
        apiKey: "anthropic-key",
      },
    ]);
  });

  it("parses PROVIDERS ollama blocks with transport and headers", () => {
    const registry = loadProviderRegistry({
      providersCsv: "ollama",
      env: {
        PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
        PROVIDER_OLLAMA_API: "openai-completions",
        PROVIDER_OLLAMA_API_KEY: "secret",
        PROVIDER_OLLAMA_HEADERS: '{"User-Agent":"Threadcord"}',
        PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
      },
    });

    expect(registry.providers[0]).toMatchObject({
      id: "ollama",
      models: ["llama3.1:8b"],
      apiKey: "secret",
      transport: {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        headers: { "User-Agent": "Threadcord" },
      },
    });
  });

  it("unions sugar and PROVIDERS model lists for the same provider", () => {
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic-key",
      anthropicModels: "claude-sonnet-4-5",
      providersCsv: "anthropic",
      env: {
        PROVIDER_ANTHROPIC_MODELS: "claude-opus-4-1",
      },
    });

    expect(registry.providers[0]?.models).toEqual([
      "claude-sonnet-4-5",
      "claude-opus-4-1",
    ]);
  });

  it("preserves null-prototype headers when sugar merges with PROVIDERS transport", () => {
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic-key",
      anthropicModels: "claude-sonnet-4-5",
      providersCsv: "anthropic",
      env: {
        PROVIDER_ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
        PROVIDER_ANTHROPIC_HEADERS:
          '{"User-Agent":"Threadcord","__proto__":"ignored"}',
      },
    });

    const headers = registry.providers[0]?.transport?.headers;
    expect(Object.getPrototypeOf(headers)).toBeNull();
    expect(headers?.["User-Agent"]).toBe("Threadcord");
  });

  it("merges PROVIDERS anthropic transport with anthropic sugar models", () => {
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic-key",
      anthropicModels: "claude-sonnet-4-5",
      providersCsv: "anthropic",
      env: {
        PROVIDER_ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
        PROVIDER_ANTHROPIC_API: "anthropic-messages",
        PROVIDER_ANTHROPIC_MODELS: "claude-sonnet-4-5",
      },
    });

    expect(registry.providers[0]).toEqual({
      id: "anthropic",
      models: ["claude-sonnet-4-5"],
      apiKey: "anthropic-key",
      transport: {
        baseUrl: "https://gateway.example.com/anthropic",
        api: "anthropic-messages",
      },
    });
  });

  it("orders built-in anthropic before openai before custom providers", () => {
    const allowed = deriveAllowedModels(
      loadProviderRegistry({
        anthropicApiKey: "anthropic-key",
        anthropicModels: "claude-sonnet-4-5",
        openaiApiKey: "openai-key",
        openaiModels: "gpt-5-codex",
        providersCsv: "ollama",
        env: {
          PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
          PROVIDER_OLLAMA_API: "openai-completions",
          PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
        },
      }),
    );

    expect(allowed).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5-codex",
      "ollama/llama3.1:8b",
    ]);
  });

  it("rejects invalid provider ids", () => {
    expect(() =>
      parseProviderBlock({} as NodeJS.ProcessEnv, "Ollama", false),
    ).toThrow(/Invalid provider id/);
  });

  it("rejects unsupported provider APIs", () => {
    expect(() =>
      parseProviderBlock(
        {
          PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
          PROVIDER_OLLAMA_API: "unsupported-api",
          PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
        },
        "ollama",
        false,
      ),
    ).toThrow(/must be one of/);
  });

  it("requires anthropic api key when anthropic models are configured", () => {
    expect(() =>
      loadProviderRegistry({
        anthropicModels: "claude-sonnet-4-5",
      }),
    ).toThrow(/ANTHROPIC_API_KEY is required/);
  });
});
