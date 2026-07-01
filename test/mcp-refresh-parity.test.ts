import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentTurn } from "../src/agentturn/index.js";
import type { McpServerSnapshot } from "../src/mcp/registry.js";
import { FakeMcpRegistry } from "./support/fake-mcp-registry.js";
import { World, flush } from "./support/orchestrator-harness.js";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "mcp-parity-"));
}

function serverIds(servers: McpServerSnapshot[]): string[] {
  return servers.map((s) => s.id);
}

describe("MCP refresh parity", () => {
  it("reads the registry snapshot before the first coding prompt", async () => {
    const world = new World(1);
    await world.fakeMcpRegistry.addServerFromCommand(
      "pre-existing",
      "https://mcp.example.com",
      "sse",
    );

    await world.submitRaw("m-initial");
    await flush();

    expect(world.fakeAgentTurn.mcpConfigCalls).toHaveLength(1);
    const call = world.fakeAgentTurn.mcpConfigCalls[0]!;
    expect(call.role).toBe("coding");
    expect(serverIds(call.servers)).toContain("pre-existing");
  });

  it("materializes a parseable .mcp.json before the first coding prompt", async () => {
    const world = new World(1);
    await world.fakeMcpRegistry.addServerFromCommand(
      "server-a",
      "https://a.example.com",
      "sse",
      "tok-a",
    );

    const result = await world.submitRaw("m-parseable");
    await flush();

    const config = await world.fakeMcpRegistry.readConfig(result.task!.workspacePath);
    expect(config).toEqual({
      mcpServers: [
        { id: "server-a", type: "remote", url: "https://a.example.com", headers: { Authorization: "Bearer tok-a" } },
      ],
    });
  });

  it("a server added during a waiting task is visible to the next follow-up", async () => {
    const world = new World(1);
    await world.fakeMcpRegistry.addServerFromCommand(
      "initial-server",
      "https://initial.example.com",
      "sse",
    );

    const result = await world.submitRaw("m-followup-add");
    const task = result.task!;
    world.fakeAgentTurn.complete(task.agentInstanceId);
    await flush();
    expect(world.store.snapshot(task.id).status).toBe("waiting");

    await world.fakeMcpRegistry.addServerFromCommand(
      "added-mid-task",
      "https://added.example.com",
      "streamable-http",
    );

    await world.submitFollowup(task.id, "m-followup-add-msg");
    await flush();

    expect(world.fakeAgentTurn.mcpConfigCalls).toHaveLength(2);
    const followupCall = world.fakeAgentTurn.mcpConfigCalls[1]!;
    expect(serverIds(followupCall.servers)).toEqual(
      ["added-mid-task", "initial-server"].sort(),
    );
  });

  it("a server removed during a waiting task is absent from the next follow-up", async () => {
    const world = new World(1);
    await world.fakeMcpRegistry.addServerFromCommand(
      "keeper",
      "https://keeper.example.com",
      "sse",
    );
    await world.fakeMcpRegistry.addServerFromCommand(
      "removed",
      "https://removed.example.com",
      "sse",
    );

    const result = await world.submitRaw("m-followup-remove");
    const task = result.task!;
    world.fakeAgentTurn.complete(task.agentInstanceId);
    await flush();

    await world.fakeMcpRegistry.removeServer("removed");

    await world.submitFollowup(task.id, "m-followup-remove-msg");
    await flush();

    const followupCall = world.fakeAgentTurn.mcpConfigCalls[1]!;
    expect(serverIds(followupCall.servers)).toEqual(["keeper"]);
  });

  it("setup turns do not receive MCP config", async () => {
    const workspace = tempWorkspace();
    const registry = new FakeMcpRegistry();
    await registry.addServerFromCommand(
      "coding-server",
      "https://coding.example.com",
      "sse",
    );
    const agentTurn = new FakeAgentTurn({ mcpRegistry: registry });

    await agentTurn.prompt({
      instanceId: "setup:run-1",
      role: "setup",
      instruction: "configure",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: workspace,
      repo: "acme/web",
      baseBranch: "main",
      setupProfileRevision: 0,
    });
    await flush();

    expect(agentTurn.mcpConfigCalls).toHaveLength(1);
    expect(agentTurn.mcpConfigCalls[0]!.role).toBe("setup");
    expect(serverIds(agentTurn.mcpConfigCalls[0]!.servers)).toEqual(["coding-server"]);
    const config = await registry.readConfig(workspace);
    expect(config).toEqual({ mcpServers: [] });
  });
});
