import { beforeEach, describe, expect, it } from "vitest";
import { World } from "./support/orchestrator-harness.js";

let world: World;

beforeEach(() => {
  world = new World();
});

describe("cancelling a queued task", () => {
  it("ends it immediately, drops follow-ups, and lets another queued task run", async () => {
    const running = await world.submit("m-running");
    const queued = await world.submit("m-queued");
    const other = await world.submit("m-other");

    expect(world.store.snapshot(running.id).status).toBe("running");
    expect(world.store.snapshot(queued.id).status).toBe("queued");

    await world.command(queued.discordThreadId, "follow up please");
    expect(world.store.followupCount(queued.id)).toBe(1);

    const replies = await world.command(queued.discordThreadId, "cancel");
    expect(replies[0]).toContain("Cancelled");
    expect(world.store.snapshot(queued.id).status).toBe("cancelled");
    expect(world.store.followupCount(queued.id)).toBe(0);

    await world.endTurn(running.flueInstanceId);

    expect(world.store.snapshot(other.id).status).toBe("running");
    expect(world.store.snapshot(queued.id).status).toBe("cancelled");
  });
});

describe("cancelling a waiting task", () => {
  it("ends it immediately, drops follow-ups, and claims no new turn", async () => {
    const first = await world.submit("m-first");
    const second = await world.submit("m-second");

    await world.endTurn(first.flueInstanceId);
    expect(world.store.snapshot(first.id).status).toBe("waiting");
    expect(world.store.snapshot(second.id).status).toBe("running");

    await world.command(first.discordThreadId, "another change");
    expect(world.store.followupCount(first.id)).toBe(1);
    expect(world.store.snapshot(first.id).status).toBe("waiting");

    const replies = await world.command(first.discordThreadId, "cancel");
    expect(replies[0]).toContain("Cancelled");
    expect(world.store.snapshot(first.id).status).toBe("cancelled");
    expect(world.store.followupCount(first.id)).toBe(0);
    expect(world.store.snapshot(second.id).status).toBe("running");
  });
});

describe("cancelling a running task", () => {
  it("holds the slot, rejects follow-ups, and frees capacity only after agent end", async () => {
    const running = await world.submit("m-run");
    const queued = await world.submit("m-wait");
    expect(world.store.snapshot(running.id).status).toBe("running");
    expect(world.store.snapshot(queued.id).status).toBe("queued");

    const cancelReplies = await world.command(
      running.discordThreadId,
      "cancel",
    );
    expect(cancelReplies[0]).toContain("Cancellation requested");
    expect(world.store.snapshot(running.id).status).toBe("cancelling");

    // The queued task must not start while the cancelling turn holds the slot.
    expect(world.store.snapshot(queued.id).status).toBe("queued");
    expect(world.dispatched).not.toContain(queued.flueInstanceId);

    const followReplies = await world.command(
      running.discordThreadId,
      "keep going",
    );
    expect(followReplies[0]).toContain("Cancellation is in progress");
    expect(world.store.followupCount(running.id)).toBe(0);

    await world.endTurn(running.flueInstanceId);
    expect(world.store.snapshot(running.id).status).toBe("cancelled");
    expect(world.store.snapshot(queued.id).status).toBe("running");
    expect(world.posts.some((p) => p.content.includes("Cancellation complete"))).toBe(
      true,
    );
  });
});

describe("restart reconciliation", () => {
  it("finalizes cancelling work instead of resurrecting it", async () => {
    const world2 = new World(2);
    const a = await world2.submit("m-a");
    const b = await world2.submit("m-b");
    expect(world2.store.snapshot(a.id).status).toBe("running");
    expect(world2.store.snapshot(b.id).status).toBe("running");

    await world2.command(a.discordThreadId, "cancel");
    expect(world2.store.snapshot(a.id).status).toBe("cancelling");

    await world2.restart();

    expect(world2.store.snapshot(a.id).status).toBe("cancelled");
    expect(world2.store.snapshot(b.id).status).toBe("waiting");
    expect(
      world2.posts.some(
        (p) =>
          p.threadId === a.discordThreadId &&
          p.content.includes("Cancellation complete after restart"),
      ),
    ).toBe(true);
  });
});

describe("cancellation replies at the command boundary", () => {
  it("distinguishes immediate cancellation from requested cancellation", async () => {
    const running = await world.submit("m-running");
    const queued = await world.submit("m-queued");

    const queuedReply = (await world.command(queued.discordThreadId, "cancel"))[0];
    const runningReply = (
      await world.command(running.discordThreadId, "cancel")
    )[0];

    expect(queuedReply).toContain("No further turns will be dispatched");
    expect(runningReply).toContain("still winding down");
    expect(queuedReply).not.toEqual(runningReply);

    const repeat = (await world.command(running.discordThreadId, "cancel"))[0];
    expect(repeat).toContain("already cancelling");

    const afterTerminal = (
      await world.command(queued.discordThreadId, "another change")
    )[0];
    expect(afterTerminal).toContain("Task is cancelled");
  });
});
