import { describe, expect, it } from "vitest";
import {
  config,
  World,
  flush,
} from "./support/orchestrator-harness.js";

describe("restart recovery: requeue interrupted turns", () => {
  it("requeues a running turn at boot", async () => {
    const world = new World();
    const result = await world.submitRaw("m-requeue");
    const task = result.task!;
    expect(task.status).toBe("running");

    // The turn is running with attempt_count = 1.
    const originalJob = world.boss.sentJobs.find(
      (j) => j.data.taskId === task.id,
    );
    expect(originalJob).toBeDefined();
    const turnBefore = world.turnStore.snapshotTurn(
      originalJob!.data.turnId,
    );
    expect(turnBefore?.status).toBe("running");
    expect(turnBefore?.attemptCount).toBe(1);

    // Restart recovery (without autoDeliver to inspect the requeued state).
    const notifications: { threadId: string; content: string }[] = [];
    await world.orchestrator.resumeAfterRestart(async (threadId, content) => {
      notifications.push({ threadId, content });
    });

    // Turn is back to queued with attempt_count preserved.
    const turnAfter = world.turnStore.snapshotTurn(
      originalJob!.data.turnId,
    );
    expect(turnAfter?.status).toBe("queued");
    expect(turnAfter?.attemptCount).toBe(1);

    // Task transitioned running → queued.
    expect(world.store.snapshot(task.id).status).toBe("queued");

    // The old boss job was cancelled and a fresh one was sent.
    const jobsForTask = world.boss.sentJobs.filter(
      (j) => j.data.taskId === task.id,
    );
    expect(jobsForTask).toHaveLength(2);
    expect(jobsForTask[0]!.state).toBe("cancelled");
    expect(jobsForTask[1]!.state).toBe("created");

    // Thread was notified with the new message.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.threadId).toBe(task.discordThreadId);
    expect(notifications[0]!.content).toBe(
      "Restart detected. The interrupted turn was requeued.",
    );
  });

  it("continues to the next task when one notification throws", async () => {
    const world = new World(2);

    const result1 = await world.submitRaw("m-bad-recover");
    const result2 = await world.submitRaw("m-good-recover");
    const badThreadId = result1.task!.discordThreadId;
    const goodTaskId = result2.task!.id;

    expect(result1.task!.status).toBe("running");
    expect(result2.task!.status).toBe("running");

    let notifyCalls = 0;
    await world.restart(async (threadId, _content) => {
      notifyCalls++;
      if (threadId === badThreadId) {
        throw new Error("discord: channel not sendable");
      }
    });

    // Both tasks were visited despite the notification failure.
    expect(notifyCalls).toBe(2);
    // Both tasks were requeued and auto-delivered.
    expect(world.store.snapshot(goodTaskId).status).toBe("running");
    expect(world.store.snapshot(result1.task!.id).status).toBe("running");
  });

  it("enqueues a boss job for a queued turn with no boss job", async () => {
    const world = new World();

    // Seed a task and a queued turn with no boss job (simulates backfill
    // from the legacy task_followups table).
    const taskId = "task-orphan";
    const turnId = "turn-orphan";
    world.store.seedTask({
      id: taskId,
      discordMessageId: "m-orphan",
      discordThreadId: "thread-orphan",
      flueInstanceId: "discord:thread:thread-orphan",
      workspacePath: "/workspaces/task-orphan",
      repo: "acme/web",
      branch: "main",
      model: config.defaultModel,
      instruction: "Do the work",
      setupProfileRevision: 2,
      status: "waiting",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    world.turnStore.seedTurn({
      id: turnId,
      taskId,
      source: "followup",
      instruction: "fix the tests",
      discordMessageId: "m-followup-orphan",
      status: "queued",
      attemptCount: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    await world.orchestrator.resumeAfterRestart(async () => {});
    await flush();

    // A boss job was sent for the orphaned queued turn.
    const orphanJob = world.boss.sentJobs.find(
      (j) => j.data.turnId === turnId,
    );
    expect(orphanJob).toBeDefined();
    expect(orphanJob!.data.taskId).toBe(taskId);
    expect(orphanJob!.options.singletonKey).toBe(taskId);
  });
});
