import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  GUEST_PI_AGENT_DIR,
  loadProviderRegistry,
  materializePiSessionConfig,
} from "../../src/providers/index.js";

const workspaceDirs: string[] = [];

afterEach(() => {
  workspaceDirs.length = 0;
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "threadcord-pi-session-"));
  workspaceDirs.push(dir);
  return dir;
}

describe("materializePiSessionConfig", () => {
  it("writes project Pi settings and transport override models.json for opencode-go", async () => {
    const workspacePath = await makeWorkspace();
    const registry = loadProviderRegistry({
      providersCsv: "opencode-go",
      env: {
        PROVIDER_OPENCODE_GO_BASE_URL: "https://opencode.ai/zen/go/v1",
        PROVIDER_OPENCODE_GO_API: "openai-completions",
        PROVIDER_OPENCODE_GO_API_KEY: "opencode-secret",
        PROVIDER_OPENCODE_GO_MODELS: "deepseek-v4-flash",
      },
    });

    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/threadcord",
      model: "opencode-go/deepseek-v4-flash",
      registry,
    });

    expect(result).toEqual({ wroteModelsJson: true, agentDir: GUEST_PI_AGENT_DIR });

    const settings = JSON.parse(
      await readFile(
        join(workspacePath, "threadcord", ".pi", "settings.json"),
        "utf8",
      ),
    );
    expect(settings).toEqual({
      defaultProvider: "opencode-go",
      defaultModel: "deepseek-v4-flash",
    });

    const models = JSON.parse(
      await readFile(
        join(workspacePath, ".pi", "agent", "models.json"),
        "utf8",
      ),
    );
    expect(models.providers["opencode-go"]).toMatchObject({
      baseUrl: "https://opencode.ai/zen/go/v1",
      api: "openai-completions",
    });
  });

  it("writes models.json for custom providers", async () => {
    const workspacePath = await makeWorkspace();
    const registry = loadProviderRegistry({
      providersCsv: "ollama",
      env: {
        PROVIDER_OLLAMA_BASE_URL: "http://localhost:11434/v1",
        PROVIDER_OLLAMA_API: "openai-completions",
        PROVIDER_OLLAMA_API_KEY: "ollama",
        PROVIDER_OLLAMA_MODELS: "llama3.1:8b",
      },
    });

    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "ollama/llama3.1:8b",
      registry,
    });

    expect(result.agentDir).toBe(GUEST_PI_AGENT_DIR);

    const models = JSON.parse(
      await readFile(
        join(workspacePath, ".pi", "agent", "models.json"),
        "utf8",
      ),
    );
    expect(models.providers.ollama).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "OLLAMA_API_KEY",
      models: [{ id: "llama3.1:8b" }],
    });
  });

  it("writes only project settings for built-in providers without transport overrides", async () => {
    const workspacePath = await makeWorkspace();
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic",
      anthropicModels: "claude-sonnet-4-5",
    });

    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "anthropic/claude-sonnet-4-5",
      registry,
    });

    expect(result).toEqual({ wroteModelsJson: false });

    await expect(
      readFile(join(workspacePath, ".pi", "agent", "models.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("writes models.json for proxied built-in anthropic providers", async () => {
    const workspacePath = await makeWorkspace();
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic",
      anthropicModels: "claude-sonnet-4-5",
      providersCsv: "anthropic",
      env: {
        PROVIDER_ANTHROPIC_BASE_URL: "https://proxy/v1",
      },
    });

    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "anthropic/claude-sonnet-4-5",
      registry,
    });

    expect(result.agentDir).toBe(GUEST_PI_AGENT_DIR);
    const models = JSON.parse(
      await readFile(
        join(workspacePath, ".pi", "agent", "models.json"),
        "utf8",
      ),
    );
    expect(models.providers.anthropic.baseUrl).toBe("https://proxy/v1");
  });

  it("does not write legacy .pi-agent paths", async () => {
    const workspacePath = await makeWorkspace();
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic",
      anthropicModels: "claude-sonnet-4-5",
    });

    await materializePiSessionConfig({
      workspacePath,
      repo: "acme/threadcord",
      model: "anthropic/claude-sonnet-4-5",
      registry,
    });

    await expect(
      readFile(join(workspacePath, ".pi-agent", "settings.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("throws on invalid model references", async () => {
    const workspacePath = await makeWorkspace();
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic",
      anthropicModels: "claude-sonnet-4-5",
    });

    await expect(
      materializePiSessionConfig({
        workspacePath,
        repo: "acme/web",
        model: "no-slash",
        registry,
      }),
    ).rejects.toThrow(/invalid model reference/);
  });
});
