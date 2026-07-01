import { describe, expect, it } from "vitest";
import {
  apiKeyEnvVarForProvider,
  loadProviderRegistry,
  resolvePiSessionCredentials,
} from "../../src/providers/index.js";

describe("apiKeyEnvVarForProvider", () => {
  it("maps opencode-go to OPENCODE_API_KEY", () => {
    expect(apiKeyEnvVarForProvider("opencode-go")).toBe("OPENCODE_API_KEY");
  });

  it("normalizes hyphens to underscores for unknown custom providers", () => {
    expect(apiKeyEnvVarForProvider("my-gateway")).toBe("MY_GATEWAY_API_KEY");
  });
});

describe("resolvePiSessionCredentials", () => {
  it("forwards anthropic credentials under ANTHROPIC_API_KEY", () => {
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic-secret",
      anthropicModels: "claude-sonnet-4-5",
    });

    expect(resolvePiSessionCredentials(registry, "anthropic/claude-sonnet-4-5")).toEqual({
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
  });

  it("forwards openai credentials under OPENAI_API_KEY", () => {
    const registry = loadProviderRegistry({
      openaiApiKey: "openai-secret",
      openaiModels: "gpt-5-codex",
    });

    expect(resolvePiSessionCredentials(registry, "openai/gpt-5-codex")).toEqual({
      OPENAI_API_KEY: "openai-secret",
    });
  });

  it("forwards opencode-go credentials under OPENCODE_API_KEY", () => {
    const registry = loadProviderRegistry({
      providersCsv: "opencode-go",
      env: {
        PROVIDER_OPENCODE_GO_BASE_URL: "https://opencode.ai/zen/go/v1",
        PROVIDER_OPENCODE_GO_API: "openai-completions",
        PROVIDER_OPENCODE_GO_MODELS: "deepseek-v4-flash",
        PROVIDER_OPENCODE_GO_API_KEY: "opencode-secret",
      },
    });

    expect(
      resolvePiSessionCredentials(registry, "opencode-go/deepseek-v4-flash"),
    ).toEqual({
      OPENCODE_API_KEY: "opencode-secret",
    });
  });

  it("forwards hyphenated custom provider credentials with normalized env names", () => {
    const registry = loadProviderRegistry({
      providersCsv: "my-gateway",
      env: {
        PROVIDER_MY_GATEWAY_BASE_URL: "https://gateway.example.com/v1",
        PROVIDER_MY_GATEWAY_API: "openai-completions",
        PROVIDER_MY_GATEWAY_MODELS: "gpt-5-codex",
        PROVIDER_MY_GATEWAY_API_KEY: "gateway-secret",
      },
    });

    expect(resolvePiSessionCredentials(registry, "my-gateway/gpt-5-codex")).toEqual({
      MY_GATEWAY_API_KEY: "gateway-secret",
    });
  });

  it("returns an empty object when the provider has no configured api key", () => {
    const registry = loadProviderRegistry({
      providersCsv: "ollama",
      env: {
        PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
        PROVIDER_OLLAMA_API: "openai-completions",
        PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
      },
    });

    expect(resolvePiSessionCredentials(registry, "ollama/llama3.1:8b")).toEqual({});
  });
});
