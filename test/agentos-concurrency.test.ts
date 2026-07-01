import { describe, expect, it } from "vitest";
import { AgentOs } from "@rivet-dev/agentos-core";
import { AgentOsAgentTurn } from "../src/agentturn/agentos.js";
import type { AgentTurnInput } from "../src/agentturn/types.js";

class TrackingFakeAgentOs {
  disposeCalls = 0;
  private readonly promptGate = new Promise<void>(() => {});

  async createSession(): Promise<{ sessionId: string }> {
    return { sessionId: "session-1" };
  }

  async prompt(): Promise<{ response: { result?: unknown }; text: string }> {
    await this.promptGate;
    return { response: { result: { stopReason: "end_turn" } }, text: "done" };
  }

  onSessionEvent(): () => void {
    return () => {};
  }

  async cancelSession(): Promise<void> {}
  async closeSession(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

function baseInput(instanceId: string, workspacePath: string): AgentTurnInput {
  return {
    instanceId,
    role: "coding",
    instruction: "Do the work",
    model: "anthropic/claude-sonnet-4-5",
    workspacePath,
    repo: "acme/web",
    baseBranch: "main",
    setupProfileRevision: 2,
  };
}

describe("AgentOsAgentTurn per-instance VMs", () => {
  it("keeps separate VMs for concurrent instances", async () => {
    let createCount = 0;
    const agentTurn = new AgentOsAgentTurn({
      agentOsFactory: {
        create: async () => {
          createCount += 1;
          return new TrackingFakeAgentOs() as unknown as AgentOs;
        },
      },
    });

    const inputA = baseInput("discord:thread:a", "/workspaces/task-a");
    const inputB = baseInput("discord:thread:b", "/workspaces/task-b");

    expect(await agentTurn.prompt(inputA)).toEqual({ accepted: true });
    expect(await agentTurn.prompt(inputB)).toEqual({ accepted: true });
    expect(createCount).toBe(2);
    expect(agentTurn.getActiveVmCount()).toBe(2);
  });
});
