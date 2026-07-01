import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { materializePiSessionConfig } from "../../src/providers/index.js";
import { opencodeGoPiConfig } from "../support/pi-config-harness.js";

const PROVIDER_ENV_KEYS = [
  "OPENCODE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
] as const;

const workspaceDirs: string[] = [];
const savedProviderEnv = new Map<string, string | undefined>();

afterEach(() => {
  workspaceDirs.length = 0;
  for (const [key, value] of savedProviderEnv.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedProviderEnv.clear();
});

function withOnlyOpencodeApiKey(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    if (!savedProviderEnv.has(key)) {
      savedProviderEnv.set(key, process.env[key]);
    }
    delete process.env[key];
  }
  process.env.OPENCODE_API_KEY = "test-opencode-key";
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "threadcord-pi-model-"));
  workspaceDirs.push(dir);
  return dir;
}

async function startPiSessionAtCheckout(checkoutPath: string) {
  return createAgentSession({
    cwd: checkoutPath,
    sessionManager: SessionManager.inMemory(checkoutPath),
  });
}

describe("Pi SDK reads Threadcord checkout settings", () => {
  it("selects opencode-go after Threadcord materializes checkout project settings", async () => {
    withOnlyOpencodeApiKey();
    const workspacePath = await makeWorkspace();
    const repo = "acme/threadcord";
    const checkoutPath = join(workspacePath, "threadcord");

    await materializePiSessionConfig({
      workspacePath,
      repo,
      model: "opencode-go/deepseek-v4-flash",
      piConfig: opencodeGoPiConfig(),
    });

    const { session } = await startPiSessionAtCheckout(checkoutPath);
    const model = session.model;

    expect(model).toMatchObject({
      provider: "opencode-go",
      id: "deepseek-v4-flash",
    });
  });

  it("does not honor the task opencode-go model without checkout project settings", async () => {
    withOnlyOpencodeApiKey();
    const checkoutPath = await makeWorkspace();

    const { session } = await startPiSessionAtCheckout(checkoutPath);
    const model = session.model;

    expect(model?.provider).not.toBe("opencode-go");
    expect(model?.id).not.toBe("deepseek-v4-flash");
  });

  it("does not leave legacy .pi-agent settings that Pi AgentOS ignores", async () => {
    const workspacePath = await makeWorkspace();

    await materializePiSessionConfig({
      workspacePath,
      repo: "acme/threadcord",
      model: "opencode-go/deepseek-v4-flash",
      piConfig: opencodeGoPiConfig(),
    });

    await expect(
      readFile(join(workspacePath, ".pi-agent", "settings.json"), "utf8"),
    ).rejects.toThrow();
  });
});
