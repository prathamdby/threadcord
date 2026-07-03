import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildCustomId } from "../src/discord/ui/index.js";
import * as abortThreadTask from "../src/task/abort-thread-task.js";
import { parseThreadControlCommand } from "../src/task/abort-thread-task.js";
import {
  buildThreadControlConfirmView,
  parseThreadControlButtonCustomId,
} from "../src/task/thread-controls.js";
import { TaskOrchestrator } from "../src/task/orchestrator.js";
import {
  config,
  fakeSetupStore,
  InMemoryStore,
  World,
  flush,
} from "./support/orchestrator-harness.js";
import type { ViewPayload } from "../src/discord/ui/index.js";

const IS_COMPONENTS_V2 = 32768;

describe("parseThreadControlCommand", () => {
  it("maps status and done", () => {
    expect(parseThreadControlCommand("status")).toBe("status");
    expect(parseThreadControlCommand("  DONE  ")).toBe("done");
  });
});

describe("thread control confirm custom ids", () => {
  it("roundtrips confirm and dismiss ids", () => {
    const confirm = buildCustomId(
      "task",
      "ctl",
      "confirm",
      "abort",
      "user-1",
      "task-1",
    );
    const dismiss = buildCustomId(
      "task",
      "ctl",
      "dismiss",
      "abort",
      "user-1",
      "task-1",
    );
    expect(parseThreadControlButtonCustomId(confirm)).toEqual({
      kind: "confirm",
      command: "abort",
      userId: "user-1",
      taskId: "task-1",
    });
    expect(parseThreadControlButtonCustomId(dismiss)).toEqual({
      kind: "dismiss",
      command: "abort",
      userId: "user-1",
      taskId: "task-1",
    });
  });
});

describe("buildThreadControlConfirmView", () => {
  it("serializes a CV2 confirm view with danger confirm and secondary cancel", () => {
    const view = buildThreadControlConfirmView({
      command: "abort",
      userId: "user-1",
      taskId: "task-1",
      prompt: "Abort this task?",
    });
    expect(view).not.toHaveProperty("content");
    expect(view.flags & MessageFlags.IsComponentsV2).toBe(IS_COMPONENTS_V2);
    const body = JSON.stringify(view);
    expect(body).toContain('"label":"Confirm"');
    expect(body).toContain('"label":"Cancel"');
  });
});

describe("orchestrator thread controls", () => {
  it("does not call stopTaskWork until abort is confirmed", async () => {
    const callOrder: string[] = [];
    const originalStop = abortThreadTask.stopTaskWork;
    const stopSpy = vi.spyOn(abortThreadTask, "stopTaskWork");
    stopSpy.mockImplementation(async (...args) => {
      callOrder.push("stop");
      return originalStop(...args);
    });
    const world = new World();
    const result = await world.submitRaw("m-abort-confirm");
    const task = result.task!;
    stopSpy.mockClear();
    callOrder.length = 0;

    const message = await world.sendControlMessage(task.id, "abort-1", "abort", {
      authorId: "user-1",
    });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(message.viewReplies).toHaveLength(1);
    expect(message.viewReplies[0]!.flags & MessageFlags.IsComponentsV2).toBe(
      IS_COMPONENTS_V2,
    );

    const { deferred } = await world.clickControlButton({
      customId: buildCustomId(
        "task",
        "ctl",
        "confirm",
        "abort",
        "user-1",
        task.id,
      ),
      userId: "user-1",
      message: message,
      onDefer: () => callOrder.push("defer"),
    });
    await flush();

    expect(deferred).toBe(true);
    expect(callOrder).toEqual(["defer", "stop"]);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(world.store.snapshot(task.id).status).toBe("cancelled");
    expect(message.viewEdits.at(-1)).toMatchObject({
      flags: IS_COMPONENTS_V2,
    });
    expect(JSON.stringify(message.viewEdits.at(-1))).toContain("Aborted");
  });

  it("dismisses abort confirmation without stopping work", async () => {
    const stopSpy = vi.spyOn(abortThreadTask, "stopTaskWork");
    const world = new World();
    const result = await world.submitRaw("m-abort-dismiss");
    const task = result.task!;
    stopSpy.mockClear();

    const message = await world.sendControlMessage(task.id, "abort-2", "abort", {
      authorId: "user-1",
    });

    await world.clickControlButton({
      customId: buildCustomId(
        "task",
        "ctl",
        "dismiss",
        "abort",
        "user-1",
        task.id,
      ),
      userId: "user-1",
      message,
    });
    await flush();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(world.store.snapshot(task.id).status).toBe("running");
    expect(JSON.stringify(message.viewEdits.at(-1))).toContain("Cancelled");
  });

  it("dismisses cancel confirmation without cancelling the task", async () => {
    const stopSpy = vi.spyOn(abortThreadTask, "stopTaskWork");
    const world = new World();
    const result = await world.submitRaw("m-cancel-dismiss");
    const task = result.task!;
    stopSpy.mockClear();

    const message = await world.sendControlMessage(task.id, "cancel-2", "cancel", {
      authorId: "user-1",
    });

    await world.clickControlButton({
      customId: buildCustomId(
        "task",
        "ctl",
        "dismiss",
        "cancel",
        "user-1",
        task.id,
      ),
      userId: "user-1",
      message,
    });
    await flush();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(world.store.snapshot(task.id).status).toBe("running");
  });

  it("dismisses done confirmation without completing the task", async () => {
    const world = new World(1);
    await world.submitRaw("m-done-dismiss-running");
    const queued = await world.submitRaw("m-done-dismiss-queued");
    const task = queued.task!;
    expect(task.status).toBe("queued");

    const message = await world.sendControlMessage(task.id, "done-2", "done", {
      authorId: "user-1",
    });

    await world.clickControlButton({
      customId: buildCustomId(
        "task",
        "ctl",
        "dismiss",
        "done",
        "user-1",
        task.id,
      ),
      userId: "user-1",
      message,
    });
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("queued");
  });

  it("runs done transition only after confirm", async () => {
    const world = new World(1);
    await world.submitRaw("m-done-running");
    const queued = await world.submitRaw("m-done-queued");
    const task = queued.task!;
    expect(task.status).toBe("queued");

    const message = await world.sendControlMessage(task.id, "done-1", "done", {
      authorId: "user-1",
    });
    expect(world.store.snapshot(task.id).status).toBe("queued");

    await world.clickControlButton({
      customId: buildCustomId(
        "task",
        "ctl",
        "confirm",
        "done",
        "user-1",
        task.id,
      ),
      userId: "user-1",
      message,
    });
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("completed");
  });

  it("replies with an error when control command author is unknown", async () => {
    const world = new World();
    const result = await world.submitRaw("m-abort-no-author");
    const task = result.task!;

    const message = await world.sendControlMessage(task.id, "abort-3", "abort");

    expect(message.replies).toEqual([
      "Cannot verify who sent this command.",
    ]);
    expect(message.viewReplies).toHaveLength(0);
  });

  it("refreshes the header when the confirm outcome update fails", async () => {
    const world = new World();
    const headerRefreshes: ViewPayload[] = [];
    world.orchestrator.setHeaderPublisher(async (_threadId, _messageId, payload) => {
      headerRefreshes.push(payload);
    });
    const result = await world.submitRaw("m-abort-update-fail");
    const task = result.task!;

    const message = await world.sendControlMessage(task.id, "abort-4", "abort", {
      authorId: "user-1",
    });

    await world.clickControlButton({
      customId: buildCustomId(
        "task",
        "ctl",
        "confirm",
        "abort",
        "user-1",
        task.id,
      ),
      userId: "user-1",
      message,
      updateThrows: true,
    });
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("cancelled");
    expect(message.viewEdits).toHaveLength(0);
    expect(headerRefreshes.length).toBeGreaterThan(0);
    expect(
      headerRefreshes.some((payload) =>
        JSON.stringify(payload).includes("**State**: cancelled"),
      ),
    ).toBe(true);
  });
});

describe("TaskOrchestrator.handleControlButton", () => {
  it("rejects control buttons from a different user", async () => {
    const store = new InMemoryStore(1);
    const orchestrator = new TaskOrchestrator(
      config,
      store as never,
      fakeSetupStore,
    );
    store.seedTask({
      id: "task-1",
      discordMessageId: "m-1",
      discordThreadId: "thread-1",
      flueInstanceId: "discord:thread:thread-1",
      workspacePath: "/workspaces/task-1",
      repo: "acme/web",
      branch: "main",
      model: config.defaultModel,
      instruction: "Do the work",
      setupProfileRevision: 2,
      status: "waiting",
      initialTurnStarted: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const defer = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    await orchestrator.handleControlButton({
      customId: buildCustomId(
        "task",
        "ctl",
        "confirm",
        "cancel",
        "owner",
        "task-1",
      ),
      userId: "intruder",
      defer,
      update,
      reply,
    });

    expect(defer).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0]![0] as ViewPayload;
    expect(payload.flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
  });
});
