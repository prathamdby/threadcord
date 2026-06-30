import { describe, expect, it } from "vitest";
import { threadName } from "../src/task/thread-name.js";
import { World, flush } from "./support/orchestrator-harness.js";

describe("thread rename through orchestrator", () => {
  it("creates a placeholder thread name and renames on the initial turn", async () => {
    const world = new World();
    const result = await world.submitRaw("m-rename");
    const task = result.task!;
    const thread = result.thread;

    expect(thread.id).toBe(world.threadIdFor("m-rename"));

    world.fakeAgentTurn.complete(task.flueInstanceId);
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("waiting");
    expect(world.threadRenames).toContainEqual({
      threadId: task.discordThreadId,
      name: "Do the work",
    });
    expect(thread.setNameCalls).toContain("Do the work");
  });

  it("does not rename on follow-up turns", async () => {
    const world = new World();
    const initial = await world.submitRaw("m-followup-rename");
    const task = initial.task!;

    world.fakeAgentTurn.complete(task.flueInstanceId);
    await flush();
    expect(world.threadRenames).toHaveLength(1);

    const followup = await world.submitFollowup(
      task.id,
      "followup-1",
      "fix the tests",
    );
    expect(followup.replies[0]).toMatch(/Queued follow-up/);
    world.fakeAgentTurn.complete(task.flueInstanceId);
    await flush();

    expect(world.threadRenames).toHaveLength(1);
    expect(world.store.snapshot(task.id).status).toBe("waiting");
  });

  it("continues the task lifecycle when rename fails", async () => {
    const world = new World();
    const result = await world.submitRaw("m-rename-fail");
    const task = result.task!;

    world.orchestrator.setThreadRenameLogger({ log: () => {} });
    world.orchestrator.setThreadRenamer(async () => {
      throw new Error("discord: missing permissions");
    });

    world.fakeAgentTurn.complete(task.flueInstanceId);
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("waiting");
  });

  it("initial thread name is a placeholder derived from repo and task id", async () => {
    const world = new World();
    const messageId = "m-placeholder";
    const result = await world.submitRaw(messageId);
    const task = result.task!;
    const expected = threadName("acme/web", task.id);

    expect(expected).toMatch(/^threadcord-acme-web-[a-f0-9]{8}$/);
    expect(result.threadsCreated).toBe(1);
  });

  it("rename is scheduled after the initial turn terminal event, not before prompt", async () => {
    const world = new World();
    const { release } = world.blockNextPrompt();
    const result = await world.submitRaw("m-block-rename");
    const task = result.task!;

    await flush();
    expect(world.threadRenames).toHaveLength(0);

    release();
    await flush();
    expect(world.threadRenames).toHaveLength(0);

    world.fakeAgentTurn.complete(task.flueInstanceId);
    await flush();
    expect(world.threadRenames).toHaveLength(1);
    expect(world.threadRenames).toContainEqual({
      threadId: task.discordThreadId,
      name: "Do the work",
    });
  });

  it("logs thread rename failures through the orchestrator logger", async () => {
    const world = new World();
    const logs: {
      level: string;
      message: string;
      meta?: Record<string, unknown> | undefined;
    }[] = [];
    world.orchestrator.setThreadRenameLogger({
      log: (level, message, meta) => {
        logs.push({ level, message, meta });
      },
    });
    world.orchestrator.setThreadRenamer(async () => {
      throw new Error("discord: missing permissions");
    });

    const result = await world.submitRaw("m-rename-log");
    const task = result.task!;

    world.fakeAgentTurn.complete(task.flueInstanceId);
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("waiting");
    expect(
      logs.some(
        (log) =>
          log.message === "host-thread-namer-rename-failed" &&
          log.meta?.summary === "discord: missing permissions",
      ),
    ).toBe(true);
  });
});
