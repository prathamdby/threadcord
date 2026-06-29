import { describe, expect, it } from "vitest";
import {
  deriveAllowedModels,
  loadConfig,
  parseCustomProviders,
  providerEnvPrefix,
} from "../src/config.js";

const requiredEnv = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "discord",

  GITHUB_TOKEN: "github",
};

describe("providerEnvPrefix", () => {
  it("normalizes hyphens to underscores and uppercases the provider id", () => {
    expect(providerEnvPrefix("my-gateway")).toBe("PROVIDER_MY_GATEWAY");
    expect(providerEnvPrefix("ollama")).toBe("PROVIDER_OLLAMA");
  });
});

describe("deriveAllowedModels", () => {
  it("orders built-in anthropic before openai before custom providers", () => {
    const allowed = deriveAllowedModels({
      anthropicModels: ["claude-sonnet-4-5"],
      openaiModels: ["gpt-5-codex"],
      customProviders: [
        {
          id: "ollama",
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: ["llama3.1:8b"],
        },
      ],
      anthropicApiKey: "anthropic-key",
      openaiApiKey: "openai-key",
    });

    expect(allowed).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5-codex",
      "ollama/llama3.1:8b",
    ]);
  });

  it("uses the first custom provider model when no built-ins are configured", () => {
    const allowed = deriveAllowedModels({
      anthropicModels: [],
      openaiModels: [],
      customProviders: [
        {
          id: "ollama",
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: ["llama3.1:8b", "mistral"],
        },
      ],
      anthropicApiKey: undefined,
      openaiApiKey: undefined,
    });

    expect(allowed).toEqual(["ollama/llama3.1:8b", "ollama/mistral"]);
  });
});

describe("parseCustomProviders", () => {
  it("parses multiple providers and optional api keys from prefixed env vars", () => {
    const providers = parseCustomProviders(
      {
        PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
        PROVIDER_OLLAMA_API: "openai-completions",
        PROVIDER_OLLAMA_API_KEY: "secret",
        PROVIDER_OLLAMA_HEADERS: '{"User-Agent":"Threadcord"}',
        PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
        PROVIDER_MY_GATEWAY_BASE_URL: "https://gateway.example.com/v1",
        PROVIDER_MY_GATEWAY_API: "openai-completions",
        PROVIDER_MY_GATEWAY_MODELS: "gpt-5-codex",
      },
      "ollama,my-gateway",
    );

    expect(providers).toEqual([
      {
        id: "ollama",
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        apiKey: "secret",
        headers: { "User-Agent": "Threadcord" },
        models: ["llama3.1:8b"],
      },
      {
        id: "my-gateway",
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-completions",
        models: ["gpt-5-codex"],
      },
    ]);
  });

  it("deduplicates repeated provider ids", () => {
    const providers = parseCustomProviders(
      {
        PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
        PROVIDER_OLLAMA_API: "openai-completions",
        PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
      },
      "ollama,ollama",
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("ollama");
  });

  it("rejects provider headers that are not a JSON object of strings", () => {
    expect(() =>
      parseCustomProviders(
        {
          PROVIDER_AGENT_ROUTER_BASE_URL: "https://router.example.com/v1",
          PROVIDER_AGENT_ROUTER_API: "openai-completions",
          PROVIDER_AGENT_ROUTER_HEADERS: '{"User-Agent":42}',
          PROVIDER_AGENT_ROUTER_MODELS: "gpt-5-codex",
        },
        "agent-router",
      ),
    ).toThrow(/PROVIDER_AGENT_ROUTER_HEADERS/);
  });
});

describe("loadConfig defaultModel", () => {
  it("tracks the first derived allowed model for custom-only deployments", () => {
    const config = loadConfig({
      ...requiredEnv,
      PROVIDERS: "ollama",
      PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
      PROVIDER_OLLAMA_API: "openai-completions",
      PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
    });

    expect(config.defaultModel).toBe("ollama/llama3.1:8b");
    expect(config.allowedModels[0]).toBe(config.defaultModel);
  });

  it("updates defaultModel when provider configuration changes", () => {
    const anthropicOnly = loadConfig({
      ...requiredEnv,
      ANTHROPIC_API_KEY: "anthropic",
      ANTHROPIC_MODELS: "claude-sonnet-4-5",
    });
    const openaiOnly = loadConfig({
      ...requiredEnv,
      OPENAI_API_KEY: "openai",
      OPENAI_MODELS: "gpt-5-codex",
    });

    expect(anthropicOnly.defaultModel).toBe("anthropic/claude-sonnet-4-5");
    expect(openaiOnly.defaultModel).toBe("openai/gpt-5-codex");
  });
});
