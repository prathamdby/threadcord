import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  GUEST_PI_AGENT_DIR,
  materializePiAgentConfig,
} from "../src/agentturn/pi-agent-config.js";
import type { CustomProviderConfig } from "../src/config.js";

const customProviders: CustomProviderConfig[] = [
  {
    id: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    api: "openai-completions",
    apiKey: "opencode-secret",
    models: ["deepseek-v4-flash"],
  },
];

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
  it("writes Pi settings and custom provider models before the AgentOS session starts", async () => {
    const workspacePath = await makeWorkspace();

    const guestDir = await materializePiAgentConfig({
      workspacePath,
      model: "opencode-go/deepseek-v4-flash",
      customProviders,
    });

    expect(guestDir).toBe(GUEST_PI_AGENT_DIR);

    const settings = JSON.parse(
      await readFile(join(workspacePath, ".pi-agent", "settings.json"), "utf8"),
    );
    expect(settings).toEqual({
      defaultProvider: "opencode-go",
      defaultModel: "deepseek-v4-flash",
    });

    const models = JSON.parse(
      await readFile(join(workspacePath, ".pi-agent", "models.json"), "utf8"),
    );
    expect(models.providers["opencode-go"]).toMatchObject({
      baseUrl: "https://opencode.ai/zen/go/v1",
      api: "openai-completions",
      apiKey: "OPENCODE_API_KEY",
      models: [{ id: "deepseek-v4-flash" }],
    });
  });

  it("writes only settings for built-in providers without custom transport config", async () => {
    const workspacePath = await makeWorkspace();

    await materializePiAgentConfig({
      workspacePath,
      model: "anthropic/claude-sonnet-4-5",
      customProviders: [],
    });

    const settings = JSON.parse(
      await readFile(join(workspacePath, ".pi-agent", "settings.json"), "utf8"),
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
