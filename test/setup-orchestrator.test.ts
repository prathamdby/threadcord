import { describe, expect, it } from "vitest";
import { FakeAgentTurn } from "../src/agentturn/fake.js";
import { SetupOrchestrator } from "../src/setup/orchestrator.js";
import { composePrompt } from "../src/agents/prompts/compose.js";
import type { SetupStore } from "../src/setup/store.js";
import type { SetupProfile, SetupRun } from "../src/setup/profile.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "token",
  GITHUB_TOKEN: "github",
  WORKSPACE_ROOT: "/workspaces",
  MAX_CONCURRENT_TASKS: 1,
  AGENT_MAX_TOOL_FAILURES: 10,
  AGENT_MAX_VALIDATION_FAILURES: 3,
  PORT: 3583,
  WORKSPACE_TTL_DAYS: 14,
  MAX_ACTIVE_VMS: 2,
  RESERVED_SYSTEM_MEMORY_MB: 4096,
  MIN_FREE_DISK_MB: 2048,
  AGENTOS_SIDECAR_BIN: undefined,
  AGENTOS_SANDBOX_ENABLE: false,
  RUNTIME_LOG_LEVEL: "info",
  TURN_TIMEOUT_MS: 3600000,
  TURN_HEARTBEAT_TIMEOUT_MS: 120000,
  SETUP_INSTALL_TIMEOUT_MS: 1800000,
  ANTHROPIC_API_KEY: "anthropic-key",
  anthropicModels: ["claude-sonnet-4-5"],
  openaiModels: [],
  customProviders: [],
  allowedModels: ["anthropic/claude-sonnet-4-5"],
  defaultModel: "anthropic/claude-sonnet-4-5",
};

function createFakeStore(): SetupStore & {
  runs: SetupRun[];
  profiles: SetupProfile[];
  promoteCalls: { runId: string; environment: unknown; memoryMarkdown: string }[];
  failCalls: { runId: string; summary: string }[];
} {
  const store = {
    runs: [] as SetupRun[],
    profiles: [] as SetupProfile[],
    promoteCalls: [] as { runId: string; environment: unknown; memoryMarkdown: string }[],
    failCalls: [] as { runId: string; summary: string }[],
    async createOrStartRun(input: { repo: string; branch: string; model: string; workspacePath: string; update: boolean }) {
      const profile: SetupProfile = {
        id: "profile-1",
        repo: input.repo,
        branch: input.branch,
        status: input.update ? "updating" : "running",
        revision: 0,
        environment: {
          install: "npm ci",
          start: "",
          checks: {},
          requiredEnv: [],
          requiredServices: [],
        },
        memoryMarkdown: "",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const run: SetupRun = {
        id: "run-1",
        profileId: profile.id,
        repo: input.repo,
        branch: input.branch,
        model: input.model,
        workspacePath: input.workspacePath,
        status: "running",
        discordThreadId: "setup-thread-1",
        progressMessageIds: ["setup-status-1"],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.profiles.push(profile);
      store.runs.push(run);
      return { profile, run };
    },
    async getRunByInstanceId(instanceId: string) {
      const runId = instanceId.startsWith("setup:") ? instanceId.slice(6) : "";
      return store.runs.find((r) => r.id === runId);
    },
    async getRun(runId: string) {
      return store.runs.find((r) => r.id === runId);
    },
    async getProfileById(profileId: string) {
      return store.profiles.find((p) => p.id === profileId);
    },
    async promoteRun(input: { runId: string; environment: unknown; memoryMarkdown: string }) {
      store.promoteCalls.push(input);
      const run = store.runs.find((r) => r.id === input.runId);
      if (run) run.status = "succeeded";
      const profile = store.profiles.find((p) => p.id === run?.profileId);
      if (profile) {
        profile.status = "ready";
        profile.revision += 1;
        profile.environment = input.environment as any;
        profile.memoryMarkdown = input.memoryMarkdown;
      }
      return profile ?? { id: "profile-1", revision: 1 } as SetupProfile;
    },
    async failRun(runId: string, summary: string) {
      store.failCalls.push({ runId, summary });
      const run = store.runs.find((r) => r.id === runId);
      if (!run || run.status !== "running") return false;
      run.status = "failed";
      run.errorSummary = summary;
      return true;
    },
  };
  return store as any;
}

describe("SetupOrchestrator", () => {
  it("dispatches setup agent via AgentTurn role setup with composed prompt", async () => {
    const store = createFakeStore();
    const fakeAgentTurn = new FakeAgentTurn();
    const orchestrator = new SetupOrchestrator(config, store, fakeAgentTurn);

    await orchestrator.dispatchSetupAgent({
      runId: "run-1",
      repo: "acme/web",
      branch: "main",
      model: config.defaultModel,
      workspacePath: "/workspaces/setup/acme-web/main",
    });

    expect(fakeAgentTurn.prompted).toHaveLength(1);
    const input = fakeAgentTurn.prompted[0]!;
    expect(input.role).toBe("setup");
    expect(input.instanceId).toBe("setup:run-1");
    expect(input.model).toBe(config.defaultModel);
    expect(input.instruction).toBe(
      composePrompt({ role: "setup", ctx: { repo: "acme/web", branch: "main" } }),
    );
    expect(input.instruction).toContain("save_threadcord_setup_profile");
    expect(input.idempotencyKey).toMatch(/^setup:run-1:[0-9a-f-]{36}$/);
  });

  it("passes a unique idempotency key on each setup dispatch", async () => {
    const store = createFakeStore();
    const fakeAgentTurn = new FakeAgentTurn();
    const orchestrator = new SetupOrchestrator(config, store, fakeAgentTurn);

    await orchestrator.dispatchSetupAgent({
      runId: "run-1",
      repo: "acme/web",
      branch: "main",
      model: config.defaultModel,
      workspacePath: "/workspaces/setup/acme-web/main",
    });
    fakeAgentTurn.complete("setup:run-1");
    await orchestrator.dispatchSetupAgent({
      runId: "run-1",
      repo: "acme/web",
      branch: "main",
      model: config.defaultModel,
      workspacePath: "/workspaces/setup/acme-web/main",
    });

    expect(fakeAgentTurn.prompted).toHaveLength(2);
    const keys = fakeAgentTurn.prompted.map((input) => input.idempotencyKey);
    expect(keys[0]).toMatch(/^setup:run-1:[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^setup:run-1:[0-9a-f-]{36}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("fails the run and removes workspace when AgentTurn.prompt is rejected", async () => {
    const store = createFakeStore();
    const fakeAgentTurn = new FakeAgentTurn();
    fakeAgentTurn.rejectNext("no concurrency slot available");
    const posts: { threadId: string; content: string }[] = [];
    const orchestrator = new SetupOrchestrator(config, store, fakeAgentTurn);
    orchestrator.setMilestonePublisher(async (threadId, content) => {
      posts.push({ threadId, content });
    });

    await orchestrator.dispatchSetupAgent({
      runId: "run-1",
      repo: "acme/web",
      branch: "main",
      model: config.defaultModel,
      workspacePath: "/workspaces/setup/acme-web/main",
    });

    expect(store.failCalls).toHaveLength(1);
    expect(store.failCalls[0]!.summary).toContain("no concurrency slot available");
  });

  it("fails the run when handleAgentEnd sees a running run", async () => {
    const store = createFakeStore();
    const fakeAgentTurn = new FakeAgentTurn();
    const orchestrator = new SetupOrchestrator(config, store, fakeAgentTurn);
    const posts: { threadId: string; content: string }[] = [];
    orchestrator.setMilestonePublisher(async (threadId, content) => {
      posts.push({ threadId, content });
    });
    await store.createOrStartRun({
      repo: "acme/web",
      branch: "main",
      model: config.defaultModel,
      workspacePath: "/workspaces/setup/acme-web/main",
      update: false,
    });

    await orchestrator.handleAgentEnd("setup:run-1");

    expect(store.failCalls).toHaveLength(1);
    expect(store.failCalls[0]!.summary).toContain("without saving");
    const failedPost = posts.find((p) => p.content.includes("Setup failed"));
    expect(failedPost).toBeDefined();
  });

  it("notifies success and renders profile when handleAgentEnd sees a succeeded run", async () => {
    const store = createFakeStore();
    const fakeAgentTurn = new FakeAgentTurn();
    const orchestrator = new SetupOrchestrator(config, store, fakeAgentTurn);
    const posts: { threadId: string; content: string }[] = [];
    orchestrator.setMilestonePublisher(async (threadId, content) => {
      posts.push({ threadId, content });
    });
    await store.createOrStartRun({
      repo: "acme/web",
      branch: "main",
      model: config.defaultModel,
      workspacePath: "/workspaces/setup/acme-web/main",
      update: false,
    });
    // Simulate the run being promoted to succeeded by the save binding.
    await store.promoteRun({
      runId: "run-1",
      environment: { install: "npm ci", start: "", checks: {}, requiredEnv: [], requiredServices: [] },
      memoryMarkdown: "Setup memory.",
    });

    await orchestrator.handleAgentEnd("setup:run-1");

    expect(store.failCalls).toHaveLength(0);
    const successPost = posts.find((p) => p.content.includes("Setup finished successfully"));
    expect(successPost).toBeDefined();
    expect(successPost!.content).toContain("Profile saved at revision 1");
  });
});
