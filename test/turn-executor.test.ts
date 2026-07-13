import { beforeEach, describe, expect, it } from "vitest";
import { queuePendingUserTurnMessages } from "../src/discord/user-turn-message.js";
import {
  clearTurnWaiter,
  resolveTurnOutcome,
} from "../src/task/turn-completion.js";
import {
  registerFlueExecutionStore,
  resetOperatorAbortStateForTests,
  sessionKeyForInstance,
} from "../src/flue/agent-work-abort.js";
import { config, World, flush } from "./support/orchestrator-harness.js";

const EYES = "👀";
const CHECK = "✅";
const CROSS = "❌";
const taskFields = ["repo: acme/web", "branch: main"].join("\n");

beforeEach(() => {
  resetOperatorAbortStateForTests();
});

describe("turn executor", () => {
  it("happy path: claim → dispatch → resolve completed → turn completed, task waiting, messages drained, ✅ flipped", async () => {
    const world = new World();
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitChannelMessage(
      "m-happy",
      ["Do the work.", "", taskFields].join("\n"),
      { autoDeliver: false },
    );
    const task = result.task!;
    const turnId = world.boss.sentJobs[0]!.data.turnId;

    await world.deliver();
    await flush();

    // Executor claimed the turn, dispatched, and is waiting for outcome.
    expect(world.store.snapshot(task.id).status).toBe("running");
    expect(world.dispatched).toContain(task.flueInstanceId);
    expect(world.turnStore.snapshotTurn(turnId)?.status).toBe("running");

    // Queue a user message to verify it is drained on completion.
    queuePendingUserTurnMessages(task.flueInstanceId, ["Shipped the fix."]);

    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    // Task returned to waiting, turn is completed.
    expect(world.store.snapshot(task.id).status).toBe("waiting");
    expect(world.turnStore.snapshotTurn(turnId)?.status).toBe("completed");

    // User message was drained (posted to the thread).
    expect(posts).toContain("Shipped the fix.");

    // Reaction flipped from 👀 to ✅.
    expect(result.message.reactionLog).toEqual([
      `react:${EYES}`,
      `unreact:${EYES}`,
      `react:${CHECK}`,
    ]);
  });

  it("cancel-before-claim: requestCancel then deliver → no dispatch, turn not running", async () => {
    const world = new World();
    const result = await world.submitRaw("m-cancel-before", {}, {
      autoDeliver: false,
    });
    const task = result.task!;
    const turnId = world.boss.sentJobs[0]!.data.turnId;

    // Request cancel before the job is delivered.
    await world.turnStore.requestCancel(turnId);

    await world.deliver();
    await flush();

    // Executor saw the cancel gate and returned without dispatching.
    expect(world.dispatched).not.toContain(task.flueInstanceId);
    expect(world.store.snapshot(task.id).status).toBe("queued");
    // Turn is still queued with cancel requested (not running).
    const turn = world.turnStore.snapshotTurn(turnId);
    expect(turn?.status).toBe("queued");
    expect(turn?.cancelRequestedAt).toBeDefined();
  });

  it("cancel-mid-turn: requestCancel after bootstrap checkpoint → no dispatch, turn cancelled", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const world = new World(1, 9000, {
      bootstrap: async (task) => {
        await gate;
        return `/tmp/cancel-mid-${task.id}`;
      },
    });
    const result = await world.submitRaw("m-cancel-mid", {}, {
      autoDeliver: false,
    });
    const task = result.task!;
    const turnId = world.boss.sentJobs[0]!.data.turnId;

    await world.deliver();
    await flush();

    // Executor is running, suspended at the bootstrap gate.
    expect(world.store.snapshot(task.id).status).toBe("running");
    expect(world.dispatched).not.toContain(task.flueInstanceId);

    // Request cancel while bootstrap is in progress.
    await world.turnStore.requestCancel(turnId);

    release();
    await flush();
    await flush();

    // Executor hit the checkpoint, cancelled the turn, and returned.
    expect(world.dispatched).not.toContain(task.flueInstanceId);
    expect(world.turnStore.snapshotTurn(turnId)?.status).toBe("cancelled");
    expect(world.store.snapshot(task.id).status).toBe("waiting");
  });

  it("retry-then-terminal: non-terminal error retries (task queued), terminal error fails permanently", async () => {
    // --- Part A: non-terminal (retryCount < retryLimit) ---
    {
      const world = new World(1, 9000, {
        bootstrap: async () => {
          throw new Error("transient bootstrap failure");
        },
      });
      const posts: string[] = [];
      world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
        posts.push(content);
      });
      const result = await world.submitRaw("m-retry-a", {}, {
        autoDeliver: false,
      });
      const task = result.task!;
      const turnId = world.boss.sentJobs[0]!.data.turnId;

      await world.deliver({ retryCount: 0 });
      await flush();

      // Non-terminal: task back to queued, turn retrying, rethrow recorded.
      expect(world.store.snapshot(task.id).status).toBe("queued");
      expect(world.turnStore.snapshotTurn(turnId)?.status).toBe("queued");
      expect(world.boss.rethrownJobs).toHaveLength(1);
      expect(posts).toContain("Turn hit an error, retrying.");
    }

    // --- Part B: terminal (retryCount >= retryLimit) ---
    {
      const world = new World(1, 9000, {
        bootstrap: async () => {
          throw new Error("fatal bootstrap failure");
        },
      });
      const posts: string[] = [];
      world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
        posts.push(content);
      });
      const result = await world.submitRaw("m-retry-b", {}, {
        autoDeliver: false,
      });
      const task = result.task!;
      const turnId = world.boss.sentJobs[0]!.data.turnId;

      await world.deliver({ retryCount: config.QUEUE_RETRY_LIMIT });
      await flush();

      // Terminal: task failed, turn failed, failure message posted.
      expect(world.store.snapshot(task.id).status).toBe("failed");
      expect(world.turnStore.snapshotTurn(turnId)?.status).toBe("failed");
      expect(
        posts.some((p) => p.includes("encountered an error")),
      ).toBe(true);
    }
  });

  it("resume-after-redelivery: Flue not live → re-dispatch; Flue live → await outcome only", async () => {
    // --- Part A: Flue not live → re-dispatch ---
    {
      const world = new World();
      const result = await world.submitRaw("m-resume-not-live", {}, {
        autoDeliver: false,
      });
      const task = result.task!;
      const jobId = world.boss.sentJobs[0]!.id;
      const turnId = world.boss.sentJobs[0]!.data.turnId;

      // Simulate a prior delivery that crashed: turn running, task running.
      await world.turnStore.claimQueuedTurn(turnId);
      await world.store.transition(task.id, "queued", "running");
      clearTurnWaiter(task.flueInstanceId);

      const attemptBefore = world.turnStore.snapshotTurn(turnId)!
        .attemptCount;

      // Re-deliver the same job (force redelivery past deliveredIds).
      await world.deliver({ jobId, forceRedeliver: true });
      await flush();

      // Flue is not live (no execution store) → executor re-dispatched.
      expect(world.dispatched).toContain(task.flueInstanceId);
      // Attempt count was NOT bumped on resume.
      expect(world.turnStore.snapshotTurn(turnId)?.attemptCount).toBe(
        attemptBefore,
      );

      // Resolve the outcome and verify the task settles.
      await world.orchestrator.handleAgentEnd(task.flueInstanceId);
      await flush();
      expect(world.store.snapshot(task.id).status).toBe("waiting");
    }

    // --- Part B: Flue live → await outcome only (no re-dispatch) ---
    {
      const world = new World();
      const result = await world.submitRaw("m-resume-live", {}, {
        autoDeliver: false,
      });
      const task = result.task!;
      const jobId = world.boss.sentJobs[0]!.id;
      const turnId = world.boss.sentJobs[0]!.data.turnId;

      // Simulate a prior delivery.
      await world.turnStore.claimQueuedTurn(turnId);
      await world.store.transition(task.id, "queued", "running");
      clearTurnWaiter(task.flueInstanceId);

      // Register a fake execution store that reports the instance as live.
      registerFlueExecutionStore({
        submissions: {
          listRunningSubmissions: async () => [
            {
              sessionKey: sessionKeyForInstance(task.flueInstanceId),
              submissionId: "sub-1",
              attemptId: "att-1",
            },
          ],
        },
      } as never);

      world.dispatched.length = 0;

      await world.deliver({ jobId, forceRedeliver: true });
      await flush();

      // Flue is live → executor skipped dispatch and is awaiting outcome.
      expect(world.dispatched).not.toContain(task.flueInstanceId);

      // Resolve the outcome; executor settles without re-dispatching.
      await world.orchestrator.handleAgentEnd(task.flueInstanceId);
      await flush();
      expect(world.store.snapshot(task.id).status).toBe("waiting");
      expect(world.turnStore.snapshotTurn(turnId)?.status).toBe("completed");
    }

    // --- Part C: completion during liveness check is not lost ---
    {
      const world = new World();
      const result = await world.submitRaw("m-resume-race", {}, {
        autoDeliver: false,
      });
      const task = result.task!;
      const jobId = world.boss.sentJobs[0]!.id;
      const turnId = world.boss.sentJobs[0]!.data.turnId;

      // Simulate a prior delivery that crashed: turn running, task running.
      await world.turnStore.claimQueuedTurn(turnId);
      await world.store.transition(task.id, "queued", "running");
      clearTurnWaiter(task.flueInstanceId);

      let endTriggered = false;
      registerFlueExecutionStore({
        submissions: {
          listRunningSubmissions: async () => {
            if (!endTriggered) {
              endTriggered = true;
              // Fire completion inside the liveness await, before it returns.
              await world.orchestrator.handleAgentEnd(task.flueInstanceId);
            }
            return [
              {
                sessionKey: sessionKeyForInstance(task.flueInstanceId),
                submissionId: "sub-race",
                attemptId: "att-race",
              },
            ];
          },
        },
      } as never);

      world.dispatched.length = 0;

      try {
        await world.deliver({ jobId, forceRedeliver: true });
        await flush();

        expect(world.dispatched).not.toContain(task.flueInstanceId);
        expect(world.store.snapshot(task.id).status).toBe("waiting");
        expect(world.turnStore.snapshotTurn(turnId)?.status).toBe("completed");
      } finally {
        // Unblock any leftover waiter so a failed assertion cannot hang the
        // suite on the old ordering (outcome already dropped).
        resolveTurnOutcome(task.flueInstanceId, { kind: "completed" });
        await flush();
      }
    }
  });

  it("intake atomicity: boss.send returning null throws and prevents job creation", async () => {
    const world = new World();
    world.boss.nullOnNextSend = true;

    await expect(
      world.submitRaw("m-atomicity", {}, { autoDeliver: false }),
    ).rejects.toThrow("boss.send returned null");

    // No job was successfully sent.
    expect(world.boss.sentJobs).toHaveLength(0);
    expect(world.boss.pendingJobs).toHaveLength(0);
  });

  it("fast-finish race: outcome resolved before executor awaits → still settles completed", async () => {
    const world = new World(1, 9000, {
      dispatch: async (instanceId) => {
        world.dispatched.push(instanceId);
        // Resolve the outcome immediately during dispatch, before the
        // executor reaches `await outcomePromise`. This works because the
        // waiter is registered BEFORE dispatch (step 2.5).
        resolveTurnOutcome(instanceId, { kind: "completed" });
      },
    });
    const result = await world.submitRaw("m-fast-finish", {}, {
      autoDeliver: false,
    });
    const task = result.task!;
    const turnId = world.boss.sentJobs[0]!.data.turnId;

    await world.deliver();
    await flush();

    // The executor settled as completed despite the outcome being resolved
    // before it awaited.
    expect(world.store.snapshot(task.id).status).toBe("waiting");
    expect(world.dispatched).toContain(task.flueInstanceId);
    expect(world.turnStore.snapshotTurn(turnId)?.status).toBe("completed");
  });
});
