import { describe, expect, it } from "vitest";
import { AgentOs } from "@rivet-dev/agentos-core";
import { AgentOsAgentTurn } from "../src/agentturn/agentos.js";
import type { AgentOsCreateOptions } from "../src/agentturn/agentos.js";
import type { AgentOsAcpEvent } from "../src/agentturn/agentos-event-mapper.js";
import type { AgentTurnInput, TurnEvent } from "../src/agentturn/types.js";

const baseInput: AgentTurnInput = {
  instanceId: "discord:thread:thread-1",
  role: "coding",
  instruction: "Do the work",
  model: "anthropic/claude-sonnet-4-5",
  workspacePath: "/workspaces/task-1/repo",
  repo: "acme/web",
  baseBranch: "main",
  setupProfileRevision: 2,
};

class FakeAgentOs {
  readonly createSessionCalls: { software: string; opts: unknown }[] = [];
  readonly promptCalls: { sessionId: string; instruction: string }[] = [];
  private readonly handlers = new Map<
    string,
    (event: AgentOsAcpEvent) => void
  >();

  async createSession(software: string, opts: unknown): Promise<{ sessionId: string }> {
    this.createSessionCalls.push({ software, opts });
    return { sessionId: "session-1" };
  }

  async prompt(sessionId: string, instruction: string): Promise<{
    response: { result?: unknown };
    text: string;
  }> {
    this.promptCalls.push({ sessionId, instruction });
    return { response: { result: { stopReason: "end_turn" } }, text: "done" };
  }

  onSessionEvent(
    sessionId: string,
    handler: (event: AgentOsAcpEvent) => void,
  ): () => void {
    this.handlers.set(sessionId, handler);
    return () => this.handlers.delete(sessionId);
  }

  async cancelSession(): Promise<void> {}
  async closeSession(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class ThrowingOnCreateSessionAgentOs extends FakeAgentOs {
  async createSession(): Promise<{ sessionId: string }> {
    throw new Error("createSession failed before turnStarted");
  }
}

function waitForTerminal(
  agentTurn: AgentOsAgentTurn,
  instanceId: string,
): Promise<Extract<TurnEvent, { type: "terminal" }>> {
  return new Promise((resolve) => {
    const unsubscribe = agentTurn.onEvent((event) => {
      if (event.type === "terminal" && event.instanceId === instanceId) {
        unsubscribe();
        resolve(event as Extract<TurnEvent, { type: "terminal" }>);
      }
    });
  });
}

function createHarness({
  includeBindingsHost = true,
}: { includeBindingsHost?: boolean } = {}) {
  const fakeAgentOs = new FakeAgentOs();
  const factoryCalls: AgentOsCreateOptions[] = [];
  const deps: import("../src/agentturn/agentos.js").AgentOsAgentTurnDependencies =
    {
      agentOsFactory: {
        create: async (options) => {
          factoryCalls.push(options);
          return fakeAgentOs as unknown as AgentOs;
        },
      },
    };
  if (includeBindingsHost) {
    deps.bindingsHost = {
      githubToken: "ghp_test",
      discordUserId: "bot",
      postMessage: async () => {},
      editMessage: async () => {},
      environmentIssueStore: {
        insert: async () => {},
        listUnresolved: async () => [],
        resolve: async () => {},
      },
      setupStore: {
        getRunByInstanceId: async () => undefined,
        getProfileById: async () => undefined,
        getProfile: async () => undefined,
        promoteRun: async () => ({ id: "profile-1", revision: 1 } as any),
        failRun: async () => true,
        createDraft: async () => ({ id: "draft-1" } as any),
        updateDraft: async () => ({ id: "draft-1" } as any),
        appendReadyProfileMemory: async () => ({
          ok: true,
          profile: { revision: 1 },
        } as any),
      },
      taskStore: {
        getByInstanceId: async () => undefined,
      },
      gitExecutor: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
    };
  }
  const agentTurn = new AgentOsAgentTurn(deps);
  return { agentTurn, fakeAgentOs, factoryCalls };
}

describe("AgentOsAgentTurn input validation", () => {
  it("rejects a prompt with missing required fields", async () => {
    const agentTurn = new AgentOsAgentTurn();
    const result = await agentTurn.prompt({ ...baseInput, instruction: "" });

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain("missing required AgentTurn input fields");
    }
  });

  it("rejects the thread-namer role", async () => {
    const agentTurn = new AgentOsAgentTurn();
    const result = await agentTurn.prompt({
      ...baseInput,
      role: "thread-namer",
    });

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain("thread-namer");
    }
  });

  it("cancel on an unknown instance id is a no-op", async () => {
    const agentTurn = new AgentOsAgentTurn();
    await expect(
      agentTurn.cancel("discord:thread:unknown"),
    ).resolves.toBeUndefined();
  });

  it("returns an unsubscribe function from onEvent", () => {
    const agentTurn = new AgentOsAgentTurn();
    const unsubscribe = agentTurn.onEvent(() => {});
    expect(typeof unsubscribe).toBe("function");
  });
});

describe("AgentOsAgentTurn setup role", () => {
  it("accepts a setup role prompt and emits a turnStarted event", async () => {
    const { agentTurn, fakeAgentOs } = createHarness();
    const events: { type: string }[] = [];
    agentTurn.onEvent((event) => events.push(event as { type: string }));

    const input = {
      ...baseInput,
      role: "setup" as const,
      instanceId: "setup:run-1",
    };
    const result = await agentTurn.prompt(input);
    const terminal = await waitForTerminal(agentTurn, input.instanceId);

    expect(result.accepted).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["turnStarted", "terminal"]);
    expect(terminal).toMatchObject({
      type: "terminal",
      instanceId: input.instanceId,
      outcome: "completed",
    });
    expect(fakeAgentOs.promptCalls).toHaveLength(1);
    expect(fakeAgentOs.promptCalls[0]!.instruction).toBe(baseInput.instruction);
  });

  it("registers the setup toolkit and no MCP servers for setup role", async () => {
    const { agentTurn, factoryCalls, fakeAgentOs } = createHarness();
    await agentTurn.prompt({
      ...baseInput,
      role: "setup",
      instanceId: "setup:run-1",
    });

    expect(factoryCalls).toHaveLength(1);
    const options = factoryCalls[0]!;
    expect(options.toolKits).toHaveLength(1);
    expect(options.toolKits![0]!.name).toBe("threadcord-setup");

    const sessionOpts = fakeAgentOs.createSessionCalls[0]!.opts as {
      mcpServers?: unknown[];
      cwd: string;
    };
    expect(sessionOpts.mcpServers).toEqual([]);
    expect(sessionOpts.cwd).toBe("/workspace/web");
  });

  it("registers the coding toolkit and materializes MCP servers for coding role", async () => {
    const { agentTurn, factoryCalls } = createHarness();
    await agentTurn.prompt({
      ...baseInput,
      role: "coding",
    });

    expect(factoryCalls).toHaveLength(1);
    const options = factoryCalls[0]!;
    expect(options.toolKits).toHaveLength(1);
    expect(options.toolKits![0]!.name).toBe("threadcord-coding");
  });
});

describe("AgentOsAgentTurn pre-start failures", () => {
  it("returns typed rejection and does not emit terminal when createSession fails before turnStarted", async () => {
    const fakeAgentOs = new ThrowingOnCreateSessionAgentOs();
    const agentTurn = new AgentOsAgentTurn({
      agentOsFactory: {
        create: async () => fakeAgentOs as unknown as AgentOs,
      },
    });
    const events: TurnEvent[] = [];
    agentTurn.onEvent((event) => events.push(event));

    const result = await agentTurn.prompt(baseInput);

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain("createSession failed before turnStarted");
    }
    expect(events).toHaveLength(0);
  });
});
