import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Client } from "discord.js";
import { createApp, type CreateAppOptions } from "../src/app.js";
import type { McpRegistry } from "../src/mcp/registry.js";
import type { AgentTurn, MachineEnvironment } from "../src/agentturn/index.js";
import type { TaskOrchestrator } from "../src/task/orchestrator.js";
import type { SetupOrchestrator } from "../src/setup/orchestrator.js";
import { attachDiscordGateway } from "../src/discord/gateway.js";
import { config as testConfig } from "./support/orchestrator-harness.js";

function createFakePool(): Pool {
  return {
    query: vi.fn(async () => ({ rows: [] })),
    end: vi.fn(async () => {}),
  } as unknown as Pool;
}

function createFakeMcpRegistry() {
  return {
    warm: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    snapshot: vi.fn(async () => []),
    getConfigPath: vi.fn(() => "/tmp/.mcp.json"),
    materializeConfig: vi.fn(async () => []),
    addServer: vi.fn(async () => ({ toolCount: 0 })),
    removeServer: vi.fn(async () => true),
    tools: vi.fn(async () => []),
  };
}

function createFakeAgentTurn() {
  return {
    prompt: vi.fn(async () => ({ accepted: true })),
    cancel: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    resumeAfterRestart: vi.fn(async () => {}),
  };
}

function createFakeMachineEnvironment() {
  return {
    prepare: vi.fn(async () => ({ ok: true })),
  };
}

describe("createApp startup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("awaits resumeAfterRestart before attaching Discord handlers", async () => {
    let resumeResolved = false;
    const resume = vi.fn(async () => {
      await Promise.resolve();
      resumeResolved = true;
    });

    const taskOrchestrator = {
      resumeAfterRestart: resume,
      setMilestonePublisher: vi.fn(),
      setHeaderPublisher: vi.fn(),
      setTypingPublisher: vi.fn(),
      setThreadRenamer: vi.fn(),
      setThreadRenameLogger: vi.fn(),
    };
    const setupOrchestrator = {
      setMilestonePublisher: vi.fn(),
    };

    let attachedBeforeResumeResolved: boolean | undefined;
    const attachDiscordGateway = vi.fn(
      (_client, _config, _orch, _setupStore, _setupOrch, _mcpStore, _mcpReg) => {
        attachedBeforeResumeResolved = !resumeResolved;
      },
    );

    const discordClient = {
      isReady: vi.fn(() => false),
      channels: { fetch: vi.fn() },
    };

    await createApp({
      config: testConfig,
      pool: createFakePool(),
      mcpRegistry: createFakeMcpRegistry() as unknown as McpRegistry,
      agentTurn: createFakeAgentTurn() as unknown as AgentTurn,
      machineEnvironment: createFakeMachineEnvironment() as unknown as MachineEnvironment,
      taskOrchestrator: taskOrchestrator as unknown as TaskOrchestrator,
      setupOrchestrator: setupOrchestrator as unknown as SetupOrchestrator,
      discordClient: discordClient as unknown as Client,
      attachDiscordGateway: attachDiscordGateway as unknown as typeof attachDiscordGateway,
    });

    expect(resume).toHaveBeenCalled();
    expect(resumeResolved).toBe(true);
    expect(attachDiscordGateway).toHaveBeenCalled();
    expect(attachedBeforeResumeResolved).toBe(false);
  });
});
