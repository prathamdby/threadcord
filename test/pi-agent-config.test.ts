import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  GUEST_PI_AGENT_DIR,
  materializePiAgentConfig,
} from "../src/agentturn/pi-agent-config.js";
import type { CustomProviderConfig } from "../src/config.js";

const opencodeGoProvider: CustomProviderConfig = {
  id: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  api: "openai-completions",
  apiKey: "opencode-secret",
  models: ["deepseek-v4-flash"],
};

const ollamaProvider: CustomProviderConfig = {
  id: "ollama",
  baseUrl: "http://localhost:11434/v1",
  api: "openai-completions",
  apiKey: "ollama",
  models: ["llama3.1:8b"],
};

const workspaceDirs: string[] = [];

afterEach(async () => {
  workspaceDirs.length = 0;
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "threadcord-pi-agent-"));
  workspaceDirs.push(dir);
  return dir;
}

describe("materializePiAgentConfig", () => {
  it("writes project Pi settings for built-in opencode-go without models.json", async () => {
    const workspacePath = await makeWorkspace();
    const repo = "acme/threadcord";

    const guestDir = await materializePiAgentConfig({
      workspacePath,
      repo,
      model: "opencode-go/deepseek-v4-flash",
      customProviders: [opencodeGoProvider],
    });

    expect(guestDir).toBeUndefined();

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

    await expect(
      readFile(join(workspacePath, ".pi-agent", "models.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("writes models.json for non-built-in custom providers", async () => {
    const workspacePath = await makeWorkspace();

    const guestDir = await materializePiAgentConfig({
      workspacePath,
      repo: "acme/web",
      model: "ollama/llama3.1:8b",
      customProviders: [ollamaProvider],
    });

    expect(guestDir).toBe(GUEST_PI_AGENT_DIR);

    const settings = JSON.parse(
      await readFile(join(workspacePath, "web", ".pi", "settings.json"), "utf8"),
    );
    expect(settings).toEqual({
      defaultProvider: "ollama",
      defaultModel: "llama3.1:8b",
    });

    const models = JSON.parse(
      await readFile(join(workspacePath, ".pi-agent", "models.json"), "utf8"),
    );
    expect(models.providers.ollama).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "OLLAMA_API_KEY",
      models: [{ id: "llama3.1:8b" }],
    });
  });

  it("writes only project settings for built-in providers without custom transport config", async () => {
    const workspacePath = await makeWorkspace();

    await materializePiAgentConfig({
      workspacePath,
      repo: "acme/web",
      model: "anthropic/claude-sonnet-4-5",
      customProviders: [],
    });

    const settings = JSON.parse(
      await readFile(join(workspacePath, "web", ".pi", "settings.json"), "utf8"),
    );
    expect(settings).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
    });

    await expect(
      readFile(join(workspacePath, ".pi-agent", "models.json"), "utf8"),
    ).rejects.toThrow();
  });
});
