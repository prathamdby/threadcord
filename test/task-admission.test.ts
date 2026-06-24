import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryStore, World, flush } from "./support/orchestrator-harness.js";
import type { NewTaskRecord } from "../src/types.js";

function draftInput(messageId: string): NewTaskRecord {
  const id = randomUUID();
  return {
    id,
    discordMessageId: messageId,
    discordThreadId: `pending:${id}`,
    flueInstanceId: `pending:${id}`,
    workspacePath: `/workspaces/${id}`,
    repo: "acme/web",
    branch: "main",
    model: "anthropic/claude-sonnet-4-5",
    instruction: "Do the work",
    setupProfileRevision: 2,
  };
}

describe("task admission when Discord succeeds", () => {
  it("attaches a real thread, sends a status message, and schedules the turn", async () => {
    const world = new World();
    const result = await world.submitRaw("m-ok");

    const task = result.task;
    expect(task).toBeDefined();
    expect(task!.status).toBe("running");
    expect(task!.discordThreadId).toBe(world.threadIdFor("m-ok"));
    expect(task!.statusMessageId).toBeDefined();
    expect(result.threadsCreated).toBe(1);
    expect(result.sends).toContain("Queued");
    expect(result.sends).toContain("Started");
    expect(world.dispatched).toContain(task!.flueInstanceId);
  });

  it("queues without dispatching when no concurrency slot is free", async () => {
    const world = new World(1);
    await world.submitRaw("m-running");
    const second = await world.submitRaw("m-queued");

    expect(second.task!.status).toBe("queued");
    expect(second.sends.some((s) => s.startsWith("Queued - position"))).toBe(
      true,
    );
    expect(world.dispatched).not.toContain(second.task!.flueInstanceId);
  });
});

describe("task admission when thread creation throws", () => {
  it("leaves no schedulable task and replies in the control channel", async () => {
    const world = new World();
    const result = await world.submitRaw("m-fail", { createThread: true });

    const task = result.task;
    expect(task).toBeDefined();
    expect(task!.status).toBe("failed");
    expect(task!.errorSummary).toContain("thread create");
    expect(task!.statusMessageId).toBe(`unattached:${task!.id}`);
    expect(world.dispatched).toHaveLength(0);
    expect(result.replies.some((r) => r.includes("Could not create"))).toBe(
      true,
    );
  });
});

describe("task admission when the status message throws", () => {
  it("does not schedule a task without a real status destination", async () => {
    const world = new World();
    const result = await world.submitRaw("m-nosend", { statusSend: true });

    const task = result.task;
    expect(task!.status).toBe("failed");
    expect(task!.statusMessageId).toBe(`unattached:${task!.id}`);
    expect(world.dispatched).toHaveLength(0);
    expect(
      result.replies.some((r) =>
        r.includes("status message could not be delivered"),
      ),
    ).toBe(true);
  });
});

describe("duplicate control messages", () => {
  it("create no second thread or task after a successful admission", async () => {
    const world = new World();
    const first = await world.submitRaw("m-dup");
    expect(first.threadsCreated).toBe(1);
    expect(world.store.taskCount()).toBe(1);

    const second = await world.submitRaw("m-dup");
    expect(second.threadsCreated).toBe(0);
    expect(second.sends).toHaveLength(0);
    expect(world.store.taskCount()).toBe(1);
    expect(world.dispatched).toHaveLength(1);
  });
});

describe("scheduler ignores unattached drafts", () => {
  it("cannot claim a draft until it is attached and promoted", async () => {
    const store = new InMemoryStore(1);
    const input = draftInput("m-draft");
    const { created } = await store.createDraft(input);
    expect(created).toBe(true);

    expect(await store.claimNextTurn()).toBeUndefined();
    expect(await store.claimNextTurn(input.id)).toBeUndefined();

    const promoted = await store.attachAndPromote(
      input.id,
      "thread-real",
      "discord:thread:thread-real",
      "status-1",
    );
    expect(promoted!.status).toBe("queued");

    const claimed = await store.claimNextTurn();
    expect(claimed!.task.id).toBe(input.id);
  });

  it("only promotes a draft once", async () => {
    const store = new InMemoryStore(1);
    const input = draftInput("m-once");
    await store.createDraft(input);

    const first = await store.attachAndPromote(
      input.id,
      "thread-a",
      "discord:thread:thread-a",
      "status-a",
    );
    expect(first!.status).toBe("queued");

    const second = await store.attachAndPromote(
      input.id,
      "thread-b",
      "discord:thread:thread-b",
      "status-b",
    );
    expect(second).toBeUndefined();
  });
});

describe("milestone post failures", () => {
  it("does not reject handleAgentEnd when milestone publishing throws", async () => {
    const world = new World();
    world.orchestrator.setMilestonePublisher(async () => {
      throw new Error("discord: message too long");
    });
    const result = await world.submitRaw("m-milestone-fail");
    const task = result.task!;

    expect(task.status).toBe("running");

    await expect(
      world.orchestrator.handleAgentEnd(task.flueInstanceId),
    ).resolves.toBeUndefined();
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("waiting");
  });
});

describe("restart reconciliation of leftover drafts", () => {
  it("fails an abandoned draft instead of resurrecting it as waiting work", async () => {
    const world = new World();
    const input = draftInput("m-crash");
    await world.store.createDraft(input);
    expect(world.store.snapshot(input.id).status).toBe("draft");

    await world.restart();

    expect(world.store.snapshot(input.id).status).toBe("failed");
    expect(world.store.snapshot(input.id).statusMessageId).toBe(
      `unattached:${input.id}`,
    );
    expect(world.dispatched).toHaveLength(0);
  });
});
