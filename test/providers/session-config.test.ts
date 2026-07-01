import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  GUEST_PI_AGENT_DIR,
  loadPiConfig,
  materializePiSessionConfig,
} from "../../src/providers/index.js";
import {
  anthropicPiConfig,
  opencodeGoPiConfig,
  proxiedAnthropicPiConfig,
} from "../support/pi-config-harness.js";

describe("materializePiSessionConfig", () => {
  it("writes project Pi settings for every task model", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "threadcord-pi-"));
    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "anthropic/claude-sonnet-4-5",
      piConfig: anthropicPiConfig(),
    });

    expect(result).toEqual({ wroteModelsJson: false });

    const settings = JSON.parse(
      await readFile(join(workspacePath, "web", ".pi", "settings.json"), "utf8"),
    );
    expect(settings).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
    });
  });

  it("writes verbatim PI_MODELS_JSON when configured", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "threadcord-pi-"));
    const piConfig = proxiedAnthropicPiConfig();
    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "anthropic/claude-sonnet-4-5",
      piConfig,
    });

    expect(result).toEqual({
      agentDir: GUEST_PI_AGENT_DIR,
      wroteModelsJson: true,
    });

    const models = JSON.parse(
      await readFile(join(workspacePath, ".pi", "agent", "models.json"), "utf8"),
    );
    expect(models).toEqual(piConfig.modelsJson);
  });

  it("preserves a full custom provider block verbatim", async () => {
    const modelsJson = {
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          apiKey: "OLLAMA_API_KEY",
          models: [{ id: "llama3.1:8b" }],
        },
      },
    };
    const piConfig = loadPiConfig({
      modelsJsonRaw: JSON.stringify(modelsJson),
      env: { OLLAMA_API_KEY: "ollama" },
    });
    const workspacePath = await mkdtemp(join(tmpdir(), "threadcord-pi-"));

    await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "ollama/llama3.1:8b",
      piConfig,
    });

    const written = JSON.parse(
      await readFile(join(workspacePath, ".pi", "agent", "models.json"), "utf8"),
    );
    expect(written).toEqual(modelsJson);
  });

  it("does not write models.json for keys-only opencode-go deployments", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "threadcord-pi-"));
    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "opencode-go/deepseek-v4-flash",
      piConfig: opencodeGoPiConfig(),
    });

    expect(result).toEqual({ wroteModelsJson: false });
  });

  it("does not write legacy .pi-agent paths", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "threadcord-pi-"));
    await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "anthropic/claude-sonnet-4-5",
      piConfig: anthropicPiConfig(),
    });

    await expect(
      readFile(join(workspacePath, ".pi-agent", "settings.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("throws for invalid model refs", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "threadcord-pi-"));
    await expect(
      materializePiSessionConfig({
        workspacePath,
        repo: "acme/web",
        model: "no-slash",
        piConfig: anthropicPiConfig(),
      }),
    ).rejects.toThrow(/invalid model reference/);
  });
});
