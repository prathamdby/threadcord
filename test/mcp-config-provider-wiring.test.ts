import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultMachineEnvironment } from "../src/agentturn/machine-environment.js";
import type {
  DefaultMachineEnvironmentDependencies,
  FilesystemSnapshot,
  MachineEnvironmentConfig,
  ResourceSnapshot,
  SidecarInfo,
} from "../src/agentturn/machine-environment.js";
import { FakeAgentTurn } from "../src/agentturn/fake.js";
import { McpRegistryConfigProvider } from "../src/mcp/registry.js";
import { TaskOrchestrator } from "../src/task/orchestrator.js";
import type { TaskStore } from "../src/task/store.js";
import { FakeMcpRegistry } from "./support/fake-mcp-registry.js";
import {
  config,
  fakeSetupStore,
  flush,
  InMemoryStore,
} from "./support/orchestrator-harness.js";

const defaultResourceSnapshot: ResourceSnapshot = {
  rssBytes: 0,
  freeMemoryMb: Number.MAX_SAFE_INTEGER,
  freeDiskMb: Number.MAX_SAFE_INTEGER,
  loadAverage: [0, 0, 0],
  workspaceSizeBytes: 0,
  sidecarCount: 0,
  activeVmCount: 0,
};

const defaultFilesystemSnapshot: FilesystemSnapshot = {
  workspaceExists: true,
  workspaceWritable: true,
  checkoutExists: true,
  installMarker: true,
};

const defaultSidecarInfo: SidecarInfo = {
  path: "/opt/agentos-sidecar",
  executable: true,
  arch: "arm64",
};

function makeTurnReadyMachineEnvironment(
  mcpConfigProvider: McpRegistryConfigProvider,
): DefaultMachineEnvironment {
  const machineConfig: MachineEnvironmentConfig = {
    maxActiveVms: 2,
    reservedSystemMemoryMb: 4096,
    minFreeDiskMb: 2048,
    sandboxEnabled: false,
    githubToken: "token",
  };
  const deps: DefaultMachineEnvironmentDependencies = {
    bootstrapper: {
      bootstrap: async () => "/ignored/bootstrap-return",
    },
    installRunner: { run: async () => {} },
    resourceSnapshotProvider: {
      getSnapshot: async () => defaultResourceSnapshot,
    },
    filesystemSnapshotProvider: {
      getSnapshot: async () => defaultFilesystemSnapshot,
    },
    sidecarResolver: {
      resolve: async () => defaultSidecarInfo,
    },
    mcpConfigProvider,
    credentialsProvider: {
      hasCredentials: async () => true,
    },
  };
  return new DefaultMachineEnvironment(machineConfig, deps);
}

function tempWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), "threadcord-mcp-wiring-"));
}

describe("MCP config provider wiring", () => {
  const workspaceRoots: string[] = [];

  afterEach(() => {
    for (const root of workspaceRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails turn prepare when orchestrator and machine environment use different providers", async () => {
    const workspaceRoot = tempWorkspaceRoot();
    workspaceRoots.push(workspaceRoot);
    const mcpRegistry = new FakeMcpRegistry();
    const envProvider = new McpRegistryConfigProvider(mcpRegistry);
    const machineEnvironment = makeTurnReadyMachineEnvironment(envProvider);
    const fakeAgentTurn = new FakeAgentTurn({
      maxConcurrency: 1,
      mcpRegistry,
    });
    const store = new InMemoryStore(1);

    const orchestrator = new TaskOrchestrator(
      { ...config, WORKSPACE_ROOT: workspaceRoot },
      store as unknown as TaskStore,
      fakeSetupStore,
      fakeAgentTurn,
      machineEnvironment,
      mcpRegistry,
    );
    orchestrator.setHeaderPublisher(async () => {});

    const result = await orchestrator.startTaskFromSlash({
      initiatorMessageId: "msg-split-provider",
      pending: {
        repo: "acme/web",
        branch: "main",
        instruction: "List the libs used",
        model: config.defaultModel,
      },
      createThread: async () => ({
        id: "thread-split-provider",
        send: async (content) => ({ id: `status-${content}` }),
        pin: async () => {},
        editMessage: async () => {},
        sendTyping: async () => {},
        setName: async () => {},
      }),
    });

    await flush();

    expect(result.ok).toBe(true);
    expect(fakeAgentTurn.prompted).toHaveLength(0);
    const task = store.findByMessageId("msg-split-provider");
    expect(task?.status).toBe("failed");
    expect(task?.errorSummary).toContain("workspace path not set");
  });

  it("reaches agent prompt when orchestrator shares MCP config provider with machine environment", async () => {
    const workspaceRoot = tempWorkspaceRoot();
    workspaceRoots.push(workspaceRoot);
    const mcpRegistry = new FakeMcpRegistry();
    const sharedProvider = new McpRegistryConfigProvider(mcpRegistry);
    const machineEnvironment = makeTurnReadyMachineEnvironment(sharedProvider);
    const fakeAgentTurn = new FakeAgentTurn({
      maxConcurrency: 1,
      mcpRegistry,
    });
    const store = new InMemoryStore(1);

    const orchestrator = new TaskOrchestrator(
      { ...config, WORKSPACE_ROOT: workspaceRoot },
      store as unknown as TaskStore,
      fakeSetupStore,
      fakeAgentTurn,
      machineEnvironment,
      mcpRegistry,
      sharedProvider,
    );
    orchestrator.setMilestonePublisher(async () => {});
    orchestrator.setHeaderPublisher(async () => {});

    const result = await orchestrator.startTaskFromSlash({
      initiatorMessageId: `msg-shared-${randomUUID()}`,
      pending: {
        repo: "acme/web",
        branch: "main",
        instruction: "List the libs used",
        model: config.defaultModel,
      },
      createThread: async () => ({
        id: "thread-shared-provider",
        send: async (content) => ({ id: `status-${content}` }),
        pin: async () => {},
        editMessage: async () => {},
        sendTyping: async () => {},
        setName: async () => {},
      }),
    });

    await flush();

    expect(result.ok).toBe(true);
    expect(fakeAgentTurn.prompted).toHaveLength(1);
  });
});
