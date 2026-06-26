import { describe, expect, it } from "vitest";
import {
  queuePendingUserTurnMessages,
  setPendingUserTurnMessage,
  takePendingUserTurnMessages,
} from "../src/discord/user-turn-message.js";
import { World, flush } from "./support/orchestrator-harness.js";

const EYES = "👀";
const CHECK = "✅";
const CROSS = "❌";
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("inbound-message reactions", () => {
  it("does not react when a slash-style task is accepted", async () => {
    const world = new World();
    const result = await world.submitRaw("m-accept");

    expect(result.task!.status).toBe("running");
    expect(result.message.reactCalls).toHaveLength(0);
  });

  it("does not react when a slash-style task is queued", async () => {
    const world = new World(1);
    await world.submitRaw("m-running");
    const queued = await world.submitRaw("m-queued");

    expect(queued.task!.status).toBe("queued");
    expect(queued.message.reactCalls).toHaveLength(0);
  });

  it("leaves no orphan eyes when thread creation fails", async () => {
    const world = new World();
    const result = await world.submitRaw("m-no-thread", { createThread: true });

    expect(result.task!.status).toBe("failed");
    expect(result.message.reactCalls).toHaveLength(0);
  });

  it("does not flip reactions on slash initiator when a turn ends", async () => {
    const world = new World();
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitRaw("m-end");
    const task = result.task!;

    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("waiting");
    expect(result.message.reactionLog).toEqual([]);
    expect(posts).toContain("Turn completed. Waiting for the next instruction.");
  });

  it("drops pending user message when handleAgentEnd runs after cancel", async () => {
    const world = new World();
    const result = await world.submitRaw("m-cancel-pending");
    const task = result.task!;

    setPendingUserTurnMessage(task.flueInstanceId, "Should not post.");
    await world.store.cancelTask(task.id);
    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    expect(takePendingUserTurnMessages(task.flueInstanceId)).toEqual([]);
  });

  it("posts queued user messages without the turn-completed notice", async () => {
    const world = new World();
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitRaw("m-user-msg");
    const task = result.task!;

    queuePendingUserTurnMessages(task.flueInstanceId, [
      "Shipped the fix and opened a PR.",
    ]);
    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    expect(posts).not.toContain(
      "Turn completed. Waiting for the next instruction.",
    );
    expect(posts.filter((post) => post.startsWith("Shipped"))).toEqual([
      "Shipped the fix and opened a PR.",
    ]);
  });

  it("does not flip reactions on slash initiator when a turn fails", async () => {
    const world = new World();
    const result = await world.submitRaw("m-fail-turn");
    const task = result.task!;

    await world.orchestrator.handleAgentFailure(
      task.flueInstanceId,
      "Stream ended without finish_reason",
    );
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("failed");
    expect(result.message.reactionLog).toEqual([]);
  });

  it("reacts per follow-up initiator message and flips on that turn's end", async () => {
    const world = new World();
    const init = await world.submitRaw("m-followup-init");
    const task = init.task!;
    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();
    expect(world.store.snapshot(task.id).status).toBe("waiting");

    const followup = await world.submitFollowup(task.id, "m-followup-1");
    expect(world.store.snapshot(task.id).status).toBe("running");
    expect(followup.message.reactionLog).toEqual([`react:${EYES}`]);

    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("waiting");
    expect(followup.message.reactionLog).toEqual([
      `react:${EYES}`,
      `unreact:${EYES}`,
      `react:${CHECK}`,
    ]);
  });
});

describe("persistent typing indicator", () => {
  it("triggers sendTyping on the thread when a turn is dispatched", async () => {
    const world = new World();
    const result = await world.submitRaw("m-typing-start");

    expect(result.task!.status).toBe("running");
    expect(result.thread.sendTypingCalls).toBeGreaterThanOrEqual(1);
  });

  it("stops the typing loop when the turn ends", async () => {
    const world = new World(1, 10);
    const result = await world.submitRaw("m-typing-stop");
    const task = result.task!;

    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();
    const after = result.thread.sendTypingCalls;

    await delay(25);
    expect(result.thread.sendTypingCalls).toBe(after);
  });

  it("stops the typing loop when a turn fails", async () => {
    const world = new World(1, 10);
    const result = await world.submitRaw("m-typing-fail-stop");
    const task = result.task!;

    await world.orchestrator.handleAgentFailure(
      task.flueInstanceId,
      "Stream ended without finish_reason",
    );
    await flush();
    const after = result.thread.sendTypingCalls;

    await delay(25);
    expect(result.thread.sendTypingCalls).toBe(after);
  });

  it("keeps typing across a turn longer than the typing interval", async () => {
    const world = new World(1, 10);
    const result = await world.submitRaw("m-typing-long");
    const task = result.task!;

    await delay(25);
    expect(result.thread.sendTypingCalls).toBeGreaterThanOrEqual(2);

    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();
  });
});

describe("non-fatal reaction and typing errors", () => {
  it("does not crash the turn when react/unreact reject", async () => {
    const world = new World();
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitRaw("m-react-throws", {
      reactionFail: true,
    });
    const task = result.task!;
    expect(task.status).toBe("running");

    await expect(
      world.orchestrator.handleAgentEnd(task.flueInstanceId),
    ).resolves.toBeUndefined();
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("waiting");
    expect(posts).toContain("Turn completed. Waiting for the next instruction.");
  });

  it("does not crash the turn when sendTyping rejects", async () => {
    const world = new World();
    const result = await world.submitRaw("m-typing-throws", {
      typingFail: true,
    });
    const task = result.task!;

    expect(task.status).toBe("running");
    expect(result.thread.sendTypingCalls).toBe(0);

    await expect(
      world.orchestrator.handleAgentEnd(task.flueInstanceId),
    ).resolves.toBeUndefined();
    await flush();
    expect(world.store.snapshot(task.id).status).toBe("waiting");
  });
});

describe("cancel during an in-flight turn", () => {
  it("aborts the turn without dispatching or crashing when cancelled during setup", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const world = new World(1, 9000, {
      bootstrap: async (task) => {
        await gate;
        return `/tmp/race-${task.id}`;
      },
    });
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitRaw("m-race-setup");
    const task = result.task!;

    expect(task.status).toBe("running");
    expect(world.dispatched).not.toContain(task.flueInstanceId);

    await world.sendThreadMessage(task.id, "cancel-setup", "cancel");
    expect(world.store.snapshot(task.id).status).toBe("cancelled");
    expect(result.message.reactionLog).toEqual([]);

    release();
    await flush();
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("cancelled");
    expect(world.dispatched).not.toContain(task.flueInstanceId);
    expect(posts.some((p) => p.startsWith("Failed:"))).toBe(false);
  });

  it("does not crash or post a spurious failure when cancelled after dispatch", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const world = new World(1, 9000, {
      dispatch: async (instanceId) => {
        await gate;
        world.dispatched.push(instanceId);
      },
    });
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitRaw("m-race-dispatch");
    const task = result.task!;

    expect(task.status).toBe("running");

    await world.sendThreadMessage(task.id, "cancel-dispatch", "cancel");
    expect(world.store.snapshot(task.id).status).toBe("cancelled");

    release();
    await flush();
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("cancelled");
    expect(world.dispatched).toContain(task.flueInstanceId);
    expect(posts.some((p) => p.startsWith("Failed:"))).toBe(false);
  });
});

describe("reaction cleanup on terminal commands", () => {
  it("flips eyes to cross when a running task is cancelled", async () => {
    const world = new World();
    const result = await world.submitRaw("m-cancel-running");
    const task = result.task!;
    expect(task.status).toBe("running");

    await world.sendThreadMessage(task.id, "cancel-1", "cancel");

    expect(world.store.snapshot(task.id).status).toBe("cancelled");
    expect(result.message.reactionLog).toEqual([]);
  });

  it("flips eyes to cross on a queued follow-up when the task is cancelled", async () => {
    const world = new World();
    const init = await world.submitRaw("m-cancel-queued-init");
    const task = init.task!;
    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    const running = await world.submitFollowup(task.id, "m-cancel-queued-f1");
    expect(world.store.snapshot(task.id).status).toBe("running");

    const queued = await world.submitFollowup(task.id, "m-cancel-queued-f2");
    expect(world.store.snapshot(task.id).status).toBe("running");

    await world.sendThreadMessage(task.id, "cancel-x", "cancel");

    expect(world.store.snapshot(task.id).status).toBe("cancelled");
    expect(running.message.reactionLog).toEqual([
      `react:${EYES}`,
      `unreact:${EYES}`,
      `react:${CROSS}`,
    ]);
    expect(queued.message.reactionLog).toEqual([
      `react:${EYES}`,
      `unreact:${EYES}`,
      `react:${CROSS}`,
    ]);
  });

  it("flips eyes to check when a queued task is marked done", async () => {
    const world = new World(1);
    await world.submitRaw("m-done-running");
    const queued = await world.submitRaw("m-done-queued");
    expect(queued.task!.status).toBe("queued");
    expect(queued.message.reactCalls).toHaveLength(0);

    await world.sendThreadMessage(queued.task!.id, "done-1", "done");

    expect(world.store.snapshot(queued.task!.id).status).toBe("completed");
    expect(queued.message.reactionLog).toEqual([]);
  });
});

describe("guard against dispatching a cancelled task", () => {
  it("aborts runTurn when the task is cancelled during bootstrap", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const world = new World(1, 9000, {
      bootstrap: async (task) => {
        await gate;
        return `/tmp/cancel-during-bootstrap-${task.id}`;
      },
    });
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });

    const result = await world.submitRaw("m-cancel-bootstrap");
    const task = result.task!;
    expect(task.status).toBe("running");

    // Simulate a concurrent cancel that does not go through the orchestrator
    // (so clearInFlight is not called); the in-flight entry remains set.
    await world.store.cancelTask(task.id);
    expect(world.store.snapshot(task.id).status).toBe("cancelled");

    release();
    await flush();
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("cancelled");
    expect(world.dispatched).not.toContain(task.flueInstanceId);
    expect(posts.some((p) => p.startsWith("Agent turn accepted."))).toBe(false);
    expect(posts.some((p) => p.startsWith("Turn completed."))).toBe(false);
  });
});

describe("handleAgentEnd transition guard", () => {
  it("does not post Turn completed or flip check when a concurrent cancel wins the transition", async () => {
    const world = new World(1);
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });

    const result = await world.submitRaw("m-transition-race");
    const task = result.task!;
    expect(task.status).toBe("running");
    expect(result.message.reactionLog).toEqual([]);

    // Simulate a concurrent cancel committing between the read and the
    // running->waiting transition inside handleAgentEnd.
    world.store.breakNextTransition();

    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("cancelled");
    expect(posts.some((p) => p.startsWith("Turn completed."))).toBe(false);
    expect(result.message.reactionLog).toEqual([]);
  });
});
