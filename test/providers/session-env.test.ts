import { describe, expect, it } from "vitest";
import {
  apiKeyEnvVarForProvider,
  buildPiSessionEnv,
  loadPiConfig,
} from "../../src/providers/index.js";
import {
  anthropicPiConfig,
  opencodeGoPiConfig,
} from "../support/pi-config-harness.js";

describe("apiKeyEnvVarForProvider", () => {
  it("maps opencode-go to OPENCODE_API_KEY", () => {
    expect(apiKeyEnvVarForProvider("opencode-go")).toBe("OPENCODE_API_KEY");
  });
});

describe("buildPiSessionEnv", () => {
  it("forwards anthropic credentials under ANTHROPIC_API_KEY", () => {
    const config = anthropicPiConfig();

    expect(
      buildPiSessionEnv(config, "anthropic/claude-sonnet-4-5", {
        ANTHROPIC_API_KEY: "anthropic-secret",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
  });

  it("forwards opencode-go credentials under OPENCODE_API_KEY", () => {
    const config = opencodeGoPiConfig();

    expect(
      buildPiSessionEnv(config, "opencode-go/deepseek-v4-flash", {
        OPENCODE_API_KEY: "opencode-secret",
      }),
    ).toEqual({
      OPENCODE_API_KEY: "opencode-secret",
    });
  });

  it("forwards PI_MODELS_JSON apiKey env references", () => {
    const config = loadPiConfig({
      modelsJsonRaw: JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "OLLAMA_API_KEY",
            models: [{ id: "llama3.1:8b" }],
          },
        },
      }),
      env: { OLLAMA_API_KEY: "ollama-secret" },
    });

    expect(
      buildPiSessionEnv(config, "ollama/llama3.1:8b", {
        OLLAMA_API_KEY: "ollama-secret",
      }),
    ).toEqual({
      OLLAMA_API_KEY: "ollama-secret",
    });
  });

  it("does not copy unrelated host env vars", () => {
    const config = anthropicPiConfig();

    expect(
      buildPiSessionEnv(config, "anthropic/claude-sonnet-4-5", {
        ANTHROPIC_API_KEY: "anthropic-secret",
        DATABASE_URL: "postgres://example",
        GITHUB_TOKEN: "github",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
  });

  it("returns an empty object when the provider key is missing", () => {
    const config = anthropicPiConfig();

    expect(
      buildPiSessionEnv(config, "anthropic/claude-sonnet-4-5", {}),
    ).toEqual({});
  });
});
