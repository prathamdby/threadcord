import { describe, expect, it } from "vitest";
import { FakeAgentTurn } from "../src/agentturn/fake.js";
import type { AgentTurnInput, TurnEvent } from "../src/agentturn/types.js";
import { World, flush } from "./support/orchestrator-harness.js";

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

function codingInput(
  instanceId: string,
  idempotencyKey?: string,
): AgentTurnInput {
  return idempotencyKey === undefined
    ? { ...baseInput, instanceId }
    : { ...baseInput, instanceId, idempotencyKey };
}

describe("AgentTurn facade", () => {
  it("accepts a turn when it can start and emits turnStarted", async () => {
    const fake = new FakeAgentTurn({ maxConcurrency: 1 });
    const events: TurnEvent[] = [];
    fake.onEvent((event) => events.push(event));

    const result = await fake.prompt(codingInput("discord:thread:thread-1"));

    expect(result).toEqual({ accepted: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turnStarted",
      instanceId: "discord:thread:thread-1",
      turnId: expect.any(String),
      attemptId: expect.any(String),
    });
  });

  it("rejects a turn when max concurrency is reached and does not consume a slot", async () => {
    const fake = new FakeAgentTurn({ maxConcurrency: 1 });
    const first = await fake.prompt(codingInput("discord:thread:thread-1"));
    expect(first.accepted).toBe(true);

    const second = await fake.prompt(codingInput("discord:thread:thread-2"));
    expect(second).toEqual({
      accepted: false,
      reason: "no concurrency slot available",
    });

    // A third attempt is still rejected while the slot is held.
    const third = await fake.prompt(codingInput("discord:thread:thread-3"));
    expect(third).toEqual({
      accepted: false,
      reason: "no concurrency slot available",
    });

    // Releasing the first slot lets a new turn start.
    fake.complete("discord:thread:thread-1");
    const fourth = await fake.prompt(codingInput("discord:thread:thread-4"));
    expect(fourth.accepted).toBe(true);
  });

  it("returns a human-readable rejection reason with no stack or JSON", async () => {
    const fake = new FakeAgentTurn({ maxConcurrency: 0 });
    const result = await fake.prompt(codingInput("discord:thread:thread-1"));

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("no concurrency slot available");
      expect(result.reason).not.toContain("{");
      expect(result.reason).not.toContain("}");
      expect(result.reason).not.toContain("Error");
      expect(result.reason.length).toBeLessThan(100);
    }
  });

  it("emits turnStarted first, progress, then exactly one terminal", async () => {
    const fake = new FakeAgentTurn();
    const events: TurnEvent[] = [];
    fake.onEvent((event) => events.push(event));

    await fake.prompt(codingInput("discord:thread:thread-1"));
    fake.progress("discord:thread:thread-1", "text", { delta: "hello " });
    fake.progress("discord:thread:thread-1", "text", { delta: "world" });
    fake.complete("discord:thread:thread-1");

    expect(events.map((event) => event.type)).toEqual([
      "turnStarted",
      "progress",
      "progress",
      "terminal",
    ]);
    const last = events[events.length - 1];
    expect(last?.type).toBe("terminal");
    expect(last).toMatchObject({
      type: "terminal",
      outcome: "completed",
    });
  });

  it("emits turnStarted followed directly by terminal when there are no progress events", async () => {
    const fake = new FakeAgentTurn();
    const events: TurnEvent[] = [];
    fake.onEvent((event) => events.push(event));

    await fake.prompt(codingInput("discord:thread:thread-1"));
    fake.fail("discord:thread:thread-1", "sidecar exited on startup");

    expect(events.map((event) => event.type)).toEqual([
      "turnStarted",
      "terminal",
    ]);
  });

  it("emits terminal outcomes for completed, failed, cancelled, and aborted", async () => {
    const actions = [
      {
        outcome: "completed" as const,
        act: (f: FakeAgentTurn, id: string) => f.complete(id),
      },
      {
        outcome: "failed" as const,
        act: (f: FakeAgentTurn, id: string) => f.fail(id, "boom"),
      },
      {
        outcome: "cancelled" as const,
        act: (f: FakeAgentTurn, id: string) => f.cancel(id),
      },
      {
        outcome: "aborted" as const,
        act: (f: FakeAgentTurn, id: string) => f.abort(id, "guardrail trip"),
      },
    ];

    for (const { outcome, act } of actions) {
      const instanceId = `discord:thread:thread-${outcome}`;
      const fake = new FakeAgentTurn();
      const events: TurnEvent[] = [];
      fake.onEvent((event) => events.push(event));

      await fake.prompt(codingInput(instanceId));
      act(fake, instanceId);

      const last = events[events.length - 1];
      expect(last).toMatchObject({
        type: "terminal",
        outcome,
      });
    }
  });

  it("emits exactly one terminal event even when multiple terminal triggers fire", async () => {
    const fake = new FakeAgentTurn();
    const events: TurnEvent[] = [];
    fake.onEvent((event) => events.push(event));

    await fake.prompt(codingInput("discord:thread:thread-1"));
    fake.complete("discord:thread:thread-1");
    fake.fail("discord:thread:thread-1", "late failure");
    fake.cancel("discord:thread:thread-1");

    const terminals = events.filter((event) => event.type === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.outcome).toBe("completed");
  });

  it("cancel on an unknown instance id is a no-op", async () => {
    const fake = new FakeAgentTurn();
    const events: TurnEvent[] = [];
    fake.onEvent((event) => events.push(event));

    await expect(
      fake.cancel("discord:thread:unknown"),
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("accepts coding, setup, and thread-namer roles", async () => {
    const fake = new FakeAgentTurn({ maxConcurrency: 3 });
    const roles: AgentTurnInput["role"][] = ["coding", "setup", "thread-namer"];

    for (const role of roles) {
      const instanceId = `discord:thread:thread-${role}`;
      const result = await fake.prompt({
        ...baseInput,
        role,
        instanceId,
      });
      expect(result.accepted).toBe(true);
    }

    expect(
      new Set(fake.prompted.map((input) => input.role)),
    ).toEqual(new Set(roles));
  });

  it("does not start a duplicate turn for the same idempotency key", async () => {
    const fake = new FakeAgentTurn();
    const input = codingInput("discord:thread:thread-1", "msg-1");
    const first = await fake.prompt(input);
    expect(first.accepted).toBe(true);

    // Same idempotency key, different instanceId: still deduplicated.
    const second = await fake.prompt(
      codingInput("discord:thread:thread-2", "msg-1"),
    );
    expect(second.accepted).toBe(true);
    expect(fake.prompted).toHaveLength(1);
  });

  it("resumeAfterRestart marks in-flight turns interrupted and notifies their threads", async () => {
    const fake = new FakeAgentTurn({
      maxConcurrency: 2,
      enableRestartNotifications: true,
    });
    const notified: { threadId: string; content: string }[] = [];

    await fake.prompt(codingInput("discord:thread:thread-1"));
    await fake.prompt(codingInput("discord:thread:thread-2"));
    await fake.resumeAfterRestart(async (threadId, content) => {
      notified.push({ threadId, content });
    });

    expect(notified).toHaveLength(2);
    expect(notified.map((n) => n.threadId).sort()).toEqual([
      "thread-1",
      "thread-2",
    ]);
    // No new prompt was replayed automatically.
    expect(fake.prompted).toHaveLength(2);
  });

  it("resumeAfterRestart logs notification failures and continues", async () => {
    const fake = new FakeAgentTurn({
      maxConcurrency: 2,
      enableRestartNotifications: true,
    });
    const notified: string[] = [];

    await fake.prompt(codingInput("discord:thread:thread-bad"));
    await fake.prompt(codingInput("discord:thread:thread-good"));
    await fake.resumeAfterRestart(async (threadId) => {
      if (threadId === "thread-bad") {
        throw new Error("discord: channel not sendable");
      }
      notified.push(threadId);
    });

    expect(notified).toEqual(["thread-good"]);
  });

  it("races completion and cancel to produce exactly one terminal", async () => {
    const fake = new FakeAgentTurn();
    const events: TurnEvent[] = [];
    fake.onEvent((event) => events.push(event));

    const gate = fake.blockNextPrompt();
    const promptPromise = fake.prompt(codingInput("discord:thread:thread-1"));

    fake.complete("discord:thread:thread-1");
    fake.cancel("discord:thread:thread-1");
    gate.release();
    await promptPromise;

    const terminals = events.filter((event) => event.type === "terminal");
    expect(terminals).toHaveLength(1);
  });

  it("onEvent returns an unsubscribe function that stops delivery", async () => {
    const fake = new FakeAgentTurn();
    const events: TurnEvent[] = [];
    const unsubscribe = fake.onEvent((event) => events.push(event));

    await fake.prompt(codingInput("discord:thread:thread-1"));
    unsubscribe();
    fake.complete("discord:thread:thread-1");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("turnStarted");
  });

  it("multiple onEvent handlers receive the same events independently", async () => {
    const fake = new FakeAgentTurn();
    const a: TurnEvent[] = [];
    const b: TurnEvent[] = [];
    fake.onEvent((event) => a.push(event));
    const unsubscribeB = fake.onEvent((event) => b.push(event));

    await fake.prompt(codingInput("discord:thread:thread-1"));
    unsubscribeB();
    fake.complete("discord:thread:thread-1");

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(a.map((event) => event.type)).toEqual(["turnStarted", "terminal"]);
    expect(b[0]?.type).toBe("turnStarted");
  });

  it("rejects a prompt with missing required fields", async () => {
    const fake = new FakeAgentTurn();
    const result = await fake.prompt({ ...baseInput, instruction: "" });

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain("missing required AgentTurn input fields");
    }
  });

  it("pins the setupProfileRevision from the input on the started turn", async () => {
    const fake = new FakeAgentTurn();
    const input = codingInput("discord:thread:thread-1");
    input.setupProfileRevision = 7;

    await fake.prompt(input);

    expect(fake.prompted[0]?.setupProfileRevision).toBe(7);
  });

  it("terminal events for failed and aborted outcomes include a summary", async () => {
    const fake = new FakeAgentTurn();
    const events: TurnEvent[] = [];
    fake.onEvent((event) => events.push(event));

    await fake.prompt(codingInput("discord:thread:thread-1"));
    fake.fail("discord:thread:thread-1", "model provider error");
    expect(events[events.length - 1]).toMatchObject({
      type: "terminal",
      outcome: "failed",
      summary: "model provider error",
    });

    await fake.prompt(codingInput("discord:thread:thread-2"));
    fake.abort("discord:thread:thread-2", "validation loop");
    expect(events[events.length - 1]).toMatchObject({
      type: "terminal",
      outcome: "aborted",
      summary: "validation loop",
    });
  });
});

describe("AgentTurn orchestrator seam", () => {
  it("waiting follow-up starts a prompt and holds the slot until a terminal event", async () => {
    const world = new World(1);
    const result = await world.submitRaw("m-tracer");
    const task = result.task!;

    // End the initial turn so the task is waiting for a follow-up.
    world.fakeAgentTurn.complete(task.flueInstanceId);
    await flush();
    expect(world.store.snapshot(task.id).status).toBe("waiting");

    // A follow-up starts a new turn and holds the slot.
    await world.submitFollowup(task.id, "m-followup");
    expect(world.store.snapshot(task.id).status).toBe("running");
    expect(world.dispatched).toContain(task.flueInstanceId);

    // Queue a second task that cannot run while the slot is held.
    const queued = await world.submitRaw("m-queued");
    expect(queued.task!.status).toBe("queued");

    // A terminal event from the fake AgentTurn releases the slot.
    world.fakeAgentTurn.complete(task.flueInstanceId);
    await flush();

    expect(world.store.snapshot(task.id).status).toBe("waiting");
    expect(world.store.snapshot(queued.task!.id).status).toBe("running");
    expect(world.dispatched).toContain(queued.task!.flueInstanceId);
  });
});
