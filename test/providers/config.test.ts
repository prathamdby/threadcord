import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModels } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { loadPiConfig } from "../../src/providers/index.js";

describe("loadPiConfig", () => {
  it("derives allowed models from configured Pi providers", () => {
    const config = loadPiConfig({
      env: {
        ANTHROPIC_API_KEY: "anthropic",
        OPENAI_API_KEY: "openai",
      },
    });

    const anthropicModels = getModels("anthropic").map(
      (model) => `anthropic/${model.id}`,
    );
    const openaiModels = getModels("openai").map((model) => `openai/${model.id}`);

    expect(config.allowedModels).toEqual(
      expect.arrayContaining([...anthropicModels, ...openaiModels]),
    );
    expect(config.defaultModel).toBe(anthropicModels[0]);
  });

  it("honors DEFAULT_MODEL when it is available from configured providers", () => {
    const config = loadPiConfig({
      defaultModel: "openai/gpt-5-codex",
      env: {
        ANTHROPIC_API_KEY: "anthropic",
        OPENAI_API_KEY: "openai",
      },
    });

    expect(config.defaultModel).toBe("openai/gpt-5-codex");
  });

  it("rejects DEFAULT_MODEL values outside derived models", () => {
    expect(() =>
      loadPiConfig({
        defaultModel: "openai/gpt-5-codex",
        env: { ANTHROPIC_API_KEY: "anthropic" },
      }),
    ).toThrow(/not available from configured providers/);
  });

  it("requires at least one configured provider", () => {
    expect(() => loadPiConfig({ env: {} })).toThrow(
      /At least one Pi provider must be configured/,
    );
  });

  it("parses inline PI_MODELS_JSON", () => {
    const config = loadPiConfig({
      env: { ANTHROPIC_API_KEY: "anthropic" },
      modelsJsonRaw: JSON.stringify({
        providers: { anthropic: { baseUrl: "https://proxy/v1" } },
      }),
    });

    expect(config.modelsJson?.providers.anthropic?.baseUrl).toBe(
      "https://proxy/v1",
    );
  });

  it("reads PI_MODELS_JSON from a filesystem path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "threadcord-models-"));
    const path = join(dir, "models.json");
    await writeFile(
      path,
      JSON.stringify({
        providers: { anthropic: { baseUrl: "https://proxy/v1" } },
      }),
    );

    const config = loadPiConfig({
      modelsJsonRaw: path,
      env: { ANTHROPIC_API_KEY: "anthropic" },
    });

    expect(config.modelsJson?.providers.anthropic?.baseUrl).toBe(
      "https://proxy/v1",
    );
  });

  it("rejects unreadable PI_MODELS_JSON paths", () => {
    expect(() =>
      loadPiConfig({
        modelsJsonRaw: "/does/not/exist/models.json",
        env: { ANTHROPIC_API_KEY: "anthropic" },
      }),
    ).toThrow(/PI_MODELS_JSON path not readable/);
  });

  it("rejects invalid PI_MODELS_JSON shape", () => {
    expect(() =>
      loadPiConfig({
        modelsJsonRaw: '{"notProviders":{}}',
        env: { ANTHROPIC_API_KEY: "anthropic" },
      }),
    ).toThrow(/providers object/);
  });

  it("requires ANTHROPIC_API_KEY when anthropic models are derived", () => {
    expect(() =>
      loadPiConfig({
        defaultModel: "anthropic/claude-sonnet-4-5",
        env: {},
      }),
    ).toThrow(/At least one Pi provider must be configured/);
  });

  it("allows custom providers from PI_MODELS_JSON without pi-ai built-in keys", () => {
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
      env: { OLLAMA_API_KEY: "ollama" },
    });

    expect(config.allowedModels).toEqual(["ollama/llama3.1:8b"]);
  });
});
