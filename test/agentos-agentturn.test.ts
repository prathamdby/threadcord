import { describe, expect, it } from "vitest";
import { AgentOsAgentTurn } from "../src/agentturn/agentos.js";
import type { AgentTurnInput } from "../src/agentturn/types.js";

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

describe("AgentOsAgentTurn input validation", () => {
  it("rejects a prompt with missing required fields", async () => {
    const agentTurn = new AgentOsAgentTurn();
    const result = await agentTurn.prompt({ ...baseInput, instruction: "" });

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain("missing required AgentTurn input fields");
    }
  });

  it("rejects non-coding roles", async () => {
    const agentTurn = new AgentOsAgentTurn();
    const result = await agentTurn.prompt({ ...baseInput, role: "setup" });

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain("AgentOsAgentTurn only supports coding turns");
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
      expect(result.reason).toContain("AgentOsAgentTurn only supports coding turns");
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
