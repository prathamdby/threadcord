import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatTaskInstructionForDiscord } from "../src/discord/task-instruction-message.js";
import { InMemoryStore, World, flush, headerEditContainsState } from "./support/orchestrator-harness.js";
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
    expect(task!.progressMessageIds).toBeDefined();
    expect(result.threadsCreated).toBe(1);
    expect(result.sends).toContain("Queued");
    expect(result.thread.viewSends).toHaveLength(1);
    expect(result.sends).toContain(
      formatTaskInstructionForDiscord("Do the work"),
    );
    expect(result.sends).not.toContain("Started");
    expect(task!.headerMessageId).toBeDefined();
    expect(result.thread.pins).toEqual([task!.headerMessageId]);
    expect(headerEditContainsState(result.thread, "running")).toBe(true);
    expect(world.dispatched).toContain(task!.flueInstanceId);
  });

  it("queues without dispatching when no concurrency slot is free", async () => {
    const world = new World(1);
    await world.submitRaw("m-running");
    const second = await world.submitRaw("m-queued");

    expect(second.task!.status).toBe("queued");
    expect(second.sends.some((s) => s.startsWith("Queued - position"))).toBe(
      false,
    );
    expect(
      second.thread.viewEdits.some((edit) =>
        JSON.stringify(edit.payload).includes("**Queue**: position 1 of 1"),
      ),
    ).toBe(true);
    expect(world.dispatched).not.toContain(second.task!.flueInstanceId);
  });
});

describe("task status header", () => {
  it("refreshes the header and replies with its jump link", async () => {
    const world = new World();
    const result = await world.submitRaw("m-status");
    const task = result.task!;

    const message = await world.sendThreadMessage(
      task.id,
      "status-1",
      "status",
    );

    expect(message.replies).toEqual([
      `Live status: https://discord.com/channels/@me/${task.discordThreadId}/${task.headerMessageId}`,
    ]);
    expect(message.replies[0]).not.toContain("Status: running");
    expect(
      result.thread.viewEdits.some(
        (edit) => edit.messageId === task.headerMessageId,
      ),
    ).toBe(true);
  });
});

describe("task admission when header message throws", () => {
  it("still admits the task with no header id", async () => {
    const world = new World();
    const result = await world.submitRaw("m-no-header", { headerSend: true });

    expect(result.task!.status).toBe("running");
    expect(result.task!.headerMessageId).toBeUndefined();
    expect(result.sends).toEqual([
      formatTaskInstructionForDiscord("Do the work"),
      "Queued",
    ]);
    expect(world.dispatched).toContain(result.task!.flueInstanceId);
  });
});

describe("task admission when header pin throws", () => {
  it("still admits the task with an editable header", async () => {
    const world = new World();
    const result = await world.submitRaw("m-pin-fail", { headerPin: true });

    expect(result.task!.status).toBe("running");
    expect(result.task!.headerMessageId).toBeDefined();
    expect(result.thread.pins).toEqual([]);
    expect(
      headerEditContainsState(result.thread, "running"),
    ).toBe(true);
    expect(world.dispatched).toContain(result.task!.flueInstanceId);
  });
});

describe("task header edit failures", () => {
  it("do not fail turn completion", async () => {
    const world = new World();
    const result = await world.submitRaw("m-edit-fail", { headerEdit: true });
    const task = result.task!;

    await expect(
      world.orchestrator.handleAgentEnd(task.flueInstanceId),
    ).resolves.toBeUndefined();

    expect(world.store.snapshot(task.id).status).toBe("waiting");
  });
});

describe("task admission when thread creation throws", () => {
  it("leaves no schedulable task and reports failure via onFailure", async () => {
    const world = new World();
    const result = await world.submitRaw("m-fail", { createThread: true });

    const task = result.task;
    expect(task).toBeDefined();
    expect(task!.status).toBe("failed");
    expect(task!.errorSummary).toContain("thread create");
    expect(task!.progressMessageIds?.[0]).toBe(`unattached:${task!.id}`);
    expect(world.dispatched).toHaveLength(0);
    expect(
      result.replies.some((r) => r.includes("Could not create a thread")),
    ).toBe(true);
  });
});

describe("task admission when the status message throws", () => {
  it("does not schedule a task without a real status destination", async () => {
    const world = new World();
    const result = await world.submitRaw("m-nosend", { statusSend: true });

    const task = result.task;
    expect(task!.status).toBe("failed");
    expect(task!.progressMessageIds?.[0]).toBe(`unattached:${task!.id}`);
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

describe("draft promotion", () => {
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

describe("restart reconciliation with bad Discord threads", () => {
  it("continues processing later tasks when one thread notification throws", async () => {
    const world = new World(2);

    // Seed two running tasks so restart releases both (simulating a crash mid-turn).
    const result1 = await world.submitRaw("m-bad");
    const result2 = await world.submitRaw("m-good");
    const badThreadId = result1.task!.discordThreadId;
    const goodTaskId = result2.task!.id;

    expect(result1.task!.status).toBe("running");
    expect(result2.task!.status).toBe("running");

    // Restart: interrupted turns are requeued, then notifications fire.
    // The notify callback throws for the bad thread.
    let notifyCalls = 0;
    await world.restart(async (threadId, _content) => {
      notifyCalls++;
      if (threadId === badThreadId) {
        throw new Error("discord: channel not sendable");
      }
    });

    // Both tasks were visited.
    expect(notifyCalls).toBe(2);
    // Both tasks were requeued and auto-delivered (notification failure
    // on one doesn't block the other).
    expect(world.store.snapshot(goodTaskId).status).toBe("running");
    expect(world.store.snapshot(result1.task!.id).status).toBe("running");
  });

  it("fills scheduler slots after restart even when a notification fails", async () => {
    const world = new World(1);

    // Fill the single concurrency slot with a running task.
    const resultRunning = await world.submitRaw("m-running");
    expect(resultRunning.task!.status).toBe("running");

    // Queue a second task that can't run yet.
    const resultQueued = await world.submitRaw("m-queued");
    expect(resultQueued.task!.status).toBe("queued");

    // Restart: the running task's turn is requeued, freeing the slot.
    // The notification throws, but the queued task should still be
    // dispatched.
    world.dispatched.length = 0;
    await world.restart(async () => {
      throw new Error("discord: channel not sendable");
    });

    // The queued task was dispatched despite the notification failure.
    expect(world.dispatched).toContain(resultQueued.task!.flueInstanceId);
  });

  it("still cleans up abandoned drafts after a notification failure", async () => {
    const world = new World(1);

    // Seed a running task (simulating a crash mid-turn).
    const result = await world.submitRaw("m-running");
    expect(result.task!.status).toBe("running");

    // Also seed an abandoned draft.
    const input = draftInput("m-draft");
    await world.store.createDraft(input);

    await world.restart(async () => {
      throw new Error("discord: channel not sendable");
    });

    // The draft was still cleaned up despite the notification failure.
    expect(world.store.snapshot(input.id).status).toBe("failed");
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
    expect(world.store.snapshot(input.id).progressMessageIds?.[0]).toBe(
      `unattached:${input.id}`,
    );
    expect(world.dispatched).toHaveLength(0);
  });
});
