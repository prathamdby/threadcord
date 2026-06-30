import { describe, expect, it } from "vitest";
import { basename, join } from "node:path";
import {
  DefaultMachineEnvironment,
  FakeMachineEnvironment,
  MemoryEnvironmentIssueStore,
  validateEnvironmentIssue,
  type EnvironmentIssue,
  type ResourceSnapshot,
} from "../src/agentturn/machine-environment.js";
import type { TaskRecord } from "../src/types.js";
import type { SetupProfile } from "../src/setup/profile.js";
import { World, flush } from "./support/orchestrator-harness.js";

const baseTask: TaskRecord = {
  id: "task-1",
  discordMessageId: "msg-1",
  discordThreadId: "thread-1",
  flueInstanceId: "discord:thread:thread-1",
  workspacePath: "/workspaces/task-1",
  repo: "acme/web",
  branch: "main",
  model: "anthropic/claude-sonnet-4-5",
  instruction: "Do the work",
  setupProfileRevision: 2,
  status: "running",
  initialTurnStarted: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const baseProfile: SetupProfile = {
  id: "profile-1",
  repo: "acme/web",
  branch: "main",
  status: "ready",
  revision: 2,
  environment: {
    install: "npm ci",
    start: "",
    checks: { a: "true", b: "true" },
    requiredEnv: [],
    requiredServices: [],
  },
  memoryMarkdown: "setup memory",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function makeInput(
  overrides: {
    task?: Partial<TaskRecord>;
    source?: "initial" | "followup";
    setupProfile?: Partial<SetupProfile>;
  } = {},
) {
  const task = { ...baseTask, ...overrides.task };
  const profile = {
    ...baseProfile,
    ...overrides.setupProfile,
    environment: { ...baseProfile.environment, ...overrides.setupProfile?.environment },
  };
  return {
    instanceId: task.flueInstanceId,
    role: "coding" as const,
    task,
    source: overrides.source ?? "initial",
    setupProfile: profile,
    model: task.model,
  };
}

describe("MachineEnvironment contract", () => {
  it("prepares a turn with workspace and checkout paths", async () => {
    const env = new FakeMachineEnvironment();
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.workspacePath).toBe("/workspaces/task-1");
    expect(result.checkoutPath).toBe("/workspaces/task-1/web");
    expect(result.homePath).toBe("/workspaces/task-1/.home");
    expect(result.npmPrefixPath).toBe("/workspaces/task-1/.npm-global");
  });

  it("records workspace path stable across initial and follow-up turns", async () => {
    const env = new FakeMachineEnvironment();
    const initial = await env.prepare(makeInput({ source: "initial" }));
    const followup = await env.prepare(makeInput({ source: "followup" }));

    expect(initial.ready).toBe(true);
    expect(followup.ready).toBe(true);
    if (!initial.ready || !followup.ready) return;
    expect(initial.workspacePath).toBe(followup.workspacePath);
    expect(initial.checkoutPath).toBe(followup.checkoutPath);
  });

  it("runs setup install on initial turn only", async () => {
    const env = new FakeMachineEnvironment();
    await env.prepare(makeInput({ source: "initial" }));
    await env.prepare(makeInput({ source: "followup" }));

    expect(env.installCalls).toHaveLength(1);
    expect(env.installCalls[0]).toMatchObject({
      workspacePath: "/workspaces/task-1",
      checkoutPath: "/workspaces/task-1/web",
      installCommand: "npm ci",
    });
    expect(env.bootstrapCalls.map((c) => c.mode)).toEqual(["initial", "continue"]);
  });

  it("rejects a turn when free memory is below the reserved headroom", async () => {
    const env = new FakeMachineEnvironment({
      resourceSnapshot: {
        rssBytes: 0,
        freeMemoryMb: 2048,
        freeDiskMb: 10000,
        loadAverage: [0, 0, 0],
        workspaceSizeBytes: 0,
        sidecarCount: 0,
        activeVmCount: 0,
      },
    });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("memory");
    expect(result.issue?.kind).toBe("resource_memory");
  });

  it("rejects a turn when free disk is below the minimum", async () => {
    const env = new FakeMachineEnvironment({
      resourceSnapshot: {
        rssBytes: 0,
        freeMemoryMb: 10000,
        freeDiskMb: 1024,
        loadAverage: [0, 0, 0],
        workspaceSizeBytes: 0,
        sidecarCount: 0,
        activeVmCount: 0,
      },
    });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("disk");
    expect(result.issue?.kind).toBe("resource_disk");
  });

  it("rejects a turn when active VM count is at capacity", async () => {
    const env = new FakeMachineEnvironment({
      resourceSnapshot: {
        rssBytes: 0,
        freeMemoryMb: 10000,
        freeDiskMb: 10000,
        loadAverage: [0, 0, 0],
        workspaceSizeBytes: 0,
        sidecarCount: 0,
        activeVmCount: 2,
      },
    });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("VM");
    expect(result.issue?.kind).toBe("resource_vm_capacity");
  });

  it("readiness probe blocks the turn before any model spend", async () => {
    const env = new FakeMachineEnvironment({
      failReadinessCheck: "workspace is missing required marker",
    });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toBe("workspace is missing required marker");
    expect(result.issue).toBeDefined();
  });

  it("fails readiness when workspace is not writable", async () => {
    const env = new FakeMachineEnvironment({
      filesystemSnapshot: {
        workspaceExists: true,
        workspaceWritable: false,
        checkoutExists: true,
        installMarker: true,
      },
    });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("workspace");
  });

  it("fails readiness when repo checkout is missing", async () => {
    const env = new FakeMachineEnvironment({
      filesystemSnapshot: {
        workspaceExists: true,
        workspaceWritable: true,
        checkoutExists: false,
        installMarker: true,
      },
    });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("checkout");
  });

  it("fails readiness when install marker is missing on initial turn", async () => {
    const env = new FakeMachineEnvironment({
      filesystemSnapshot: {
        workspaceExists: true,
        workspaceWritable: true,
        checkoutExists: true,
        installMarker: false,
      },
    });
    const result = await env.prepare(makeInput({ source: "initial" }));

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("install");
  });

  it("fails readiness when sidecar is not executable", async () => {
    const env = new FakeMachineEnvironment({
      sidecarInfo: { path: "/opt/agentos-sidecar", executable: false, arch: "arm64" },
    });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("sidecar");
    expect(result.issue?.kind).toBe("sidecar_not_executable");
  });

  it("fails readiness when sidecar architecture does not match arm64", async () => {
    const env = new FakeMachineEnvironment({
      sidecarInfo: { path: "/opt/agentos-sidecar", executable: true, arch: "amd64" },
    });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("architecture");
    expect(result.issue?.kind).toBe("sidecar_arch_mismatch");
  });

  it("fails readiness when model credentials are unavailable", async () => {
    const env = new FakeMachineEnvironment({ credentialsAvailable: false });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("credentials");
    expect(result.issue?.kind).toBe("credentials_missing");
  });

  it("fails readiness when MCP config is not parseable", async () => {
    const env = new FakeMachineEnvironment({ mcpConfigValid: false });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.reason).toContain("MCP");
    expect(result.issue?.kind).toBe("mcp_config_unparseable");
  });

  it("records environment issues in the issue store and resolves them", async () => {
    const store = new MemoryEnvironmentIssueStore();
    const env = new FakeMachineEnvironment({
      resourceSnapshot: {
        rssBytes: 0,
        freeMemoryMb: 2048,
        freeDiskMb: 10000,
        loadAverage: [0, 0, 0],
        workspaceSizeBytes: 0,
        sidecarCount: 0,
        activeVmCount: 0,
      },
      issueStore: store,
    });
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.issue).toBeDefined();
    if (result.issue === undefined) throw new Error("expected issue");
    await env.reportIssue(result.issue);

    expect(store.issues).toHaveLength(1);
    expect(store.issues[0]?.kind).toBe("resource_memory");
    expect(store.issues[0]?.resolvedAt).toBeUndefined();

    await store.resolve(store.issues[0]!.id);
    expect(store.issues[0]?.resolvedAt).toBeInstanceOf(Date);
  });

  it("validates environment issue severity and kind constraints", () => {
    const valid: EnvironmentIssue = {
      id: "issue-1",
      severity: "error",
      kind: "missing_env",
      message: "x",
      requiredEnv: ["DATABASE_URL"],
      createdAt: new Date(),
    };
    expect(() => validateEnvironmentIssue(valid)).not.toThrow();

    const invalidSeverity = { ...valid, severity: "critical" };
    expect(() => validateEnvironmentIssue(invalidSeverity)).toThrow();

    const invalidKind = { ...valid, kind: "bogus" };
    expect(() => validateEnvironmentIssue(invalidKind)).toThrow();
  });

  it("logs resource samples at turn start and end", async () => {
    const env = new FakeMachineEnvironment();
    const result = await env.prepare(makeInput());
    expect(result.ready).toBe(true);

    await env.logResourceSample("end", baseTask.flueInstanceId);

    expect(env.resourceSamples).toHaveLength(2);
    expect(env.resourceSamples[0]?.tag).toBe("start");
    expect(env.resourceSamples[1]?.tag).toBe("end");
    const sample = env.resourceSamples[0]!.snapshot;
    expect(sample).toHaveProperty("rssBytes");
    expect(sample).toHaveProperty("freeMemoryMb");
    expect(sample).toHaveProperty("loadAverage");
    expect(sample).toHaveProperty("workspaceSizeBytes");
    expect(sample).toHaveProperty("sidecarCount");
    expect(sample).toHaveProperty("activeVmCount");
  });

  it("resource sample does not contain secrets", async () => {
    const env = new FakeMachineEnvironment();
    await env.prepare(makeInput());
    const sample = env.resourceSamples[0]!.snapshot;
    expect(Object.values(sample)).not.toContain(expect.stringContaining("token"));
    expect(Object.values(sample)).not.toContain(expect.stringContaining("key"));
  });

  it("excludes host secrets from the guest session env", async () => {
    const env = new FakeMachineEnvironment();
    const result = await env.prepare(makeInput());

    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("scopes workspace env per task", async () => {
    const env = new FakeMachineEnvironment();
    const taskA = { ...baseTask, id: "task-a", workspacePath: "/workspaces/task-a" };
    const taskB = { ...baseTask, id: "task-b", workspacePath: "/workspaces/task-b" };

    const resultA = await env.prepare(makeInput({ task: taskA }));
    const resultB = await env.prepare(makeInput({ task: taskB }));

    expect(resultA.ready).toBe(true);
    expect(resultB.ready).toBe(true);
    if (!resultA.ready || !resultB.ready) return;
    expect(resultA.env.HOME).toBe("/workspaces/task-a/.home");
    expect(resultB.env.HOME).toBe("/workspaces/task-b/.home");
    expect(resultA.env.NPM_CONFIG_PREFIX).toBe("/workspaces/task-a/.npm-global");
    expect(resultB.env.NPM_CONFIG_PREFIX).toBe("/workspaces/task-b/.npm-global");
  });
});

describe("MachineEnvironment orchestrator seam", () => {
  it("low memory prevents AgentTurn prompt and posts an environment milestone", async () => {
    const world = new World(1, 9000, {
      machineEnvironment: new FakeMachineEnvironment({
        resourceSnapshot: {
          rssBytes: 0,
          freeMemoryMb: 2048,
          freeDiskMb: 10000,
          loadAverage: [0, 0, 0],
          workspaceSizeBytes: 0,
          sidecarCount: 0,
          activeVmCount: 0,
        },
      }),
    });
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });

    const result = await world.submitRaw("m-low-memory");
    await flush();

    expect(world.dispatched).toHaveLength(0);
    expect(posts.some((p) => p.includes("Environment issue"))).toBe(true);
    expect(posts.some((p) => p.includes("memory"))).toBe(true);
    expect(result.task!.status).toBe("queued");
  });

  it("readiness probe failure keeps the task queued and blocks model spend", async () => {
    const world = new World(1, 9000, {
      machineEnvironment: new FakeMachineEnvironment({
        failReadinessCheck: "workspace is missing required marker",
      }),
    });
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });

    const result = await world.submitRaw("m-probe-fail");
    await flush();

    expect(world.dispatched).toHaveLength(0);
    expect(posts.some((p) => p.includes("Environment issue"))).toBe(true);
    expect(posts.some((p) => p.includes("workspace is missing required marker"))).toBe(true);
    expect(result.task!.status).toBe("queued");
  });

  it("follow-up turn does not re-run setup install", async () => {
    const world = new World(1, 9000);
    const result = await world.submitRaw("m-initial");
    const task = result.task!;
    world.fakeAgentTurn.complete(task.flueInstanceId);
    await flush();
    expect(world.store.snapshot(task.id).status).toBe("waiting");

    await world.submitFollowup(task.id, "m-followup");
    await flush();

    expect(world.fakeMachineEnvironment.installCalls).toHaveLength(1);
    expect(world.fakeMachineEnvironment.bootstrapCalls.map((c) => c.mode)).toEqual([
      "initial",
      "continue",
    ]);
  });

  it("AgentTurn input carries the task workspacePath, not the checkout path", async () => {
    const world = new World(1, 9000);
    const result = await world.submitRaw("m-workspace-path");
    await flush();

    expect(world.fakeAgentTurn.prompted).toHaveLength(1);
    const input = world.fakeAgentTurn.prompted[0]!;
    expect(input.workspacePath).toBe(result.task!.workspacePath);
    expect(input.workspacePath).not.toBe(join(result.task!.workspacePath, basename(result.task!.repo)));
  });
});

describe("DefaultMachineEnvironment with fake snapshots", () => {
  it("uses injectable resource snapshots, not real OS metrics", async () => {
    const snapshot: ResourceSnapshot = {
      rssBytes: 128,
      freeMemoryMb: 1024,
      freeDiskMb: 1024,
      loadAverage: [1, 2, 3],
      workspaceSizeBytes: 256,
      sidecarCount: 1,
      activeVmCount: 1,
    };
    const env = new DefaultMachineEnvironment(
      { maxActiveVms: 1, reservedSystemMemoryMb: 2048, minFreeDiskMb: 2048, sandboxEnabled: false, githubToken: "" },
      {
        resourceSnapshotProvider: { getSnapshot: async () => snapshot },
      },
    );
    const returned = await env.getResourceSnapshot();
    expect(returned).toEqual(snapshot);
  });
});
