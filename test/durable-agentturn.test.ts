import { describe, expect, it } from "vitest";
import {
  DurableAgentTurn,
  type DurableAgentTurnDependencies,
} from "../src/agentturn/durable-agentturn.js";
import {
  FakeAgentTurn,
  TurnRunner,
  DurableConversationLog,
  InMemoryAgentTurnPersistence,
  type AgentTurnInput,
  type TurnEvent,
} from "../src/agentturn/index.js";
import { InMemoryTurnAttemptStore } from "./support/turn-attempt-store.js";
import { InMemoryConversationLogStore } from "./support/conversation-log-store.js";
import type { AgentOsSessionEvent } from "../src/discord/session-event-bridge.js";

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

function createClock() {
  let now = 0;
  return {
    clock: { now: () => new Date(now) },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function createDurableTurn(): {
  durable: DurableAgentTurn;
  inner: FakeAgentTurn;
  turnRunner: TurnRunner;
  attemptStore: InMemoryTurnAttemptStore;
  eventStore: InMemoryConversationLogStore;
  sessionStore: InMemoryAgentTurnPersistence;
  clock: ReturnType<typeof createClock>["clock"];
  advance: ReturnType<typeof createClock>["advance"];
  events: TurnEvent[];
  bridgeEvents: AgentOsSessionEvent[];
} {
  const { clock, advance } = createClock();
  const inner = new FakeAgentTurn({ enableRestartNotifications: false });
  const attemptStore = new InMemoryTurnAttemptStore();
  const eventStore = new InMemoryConversationLogStore();
  const sessionStore = new InMemoryAgentTurnPersistence();
  const turnRunner = new TurnRunner(
    attemptStore,
    {
      leaseOwner: "test-worker",
      turnTimeoutMs: 60_000,
      heartbeatTimeoutMs: 120_000,
      setupInstallTimeoutMs: 30_000,
      maxAttempts: 3,
    },
    clock,
  );
  const conversationLog = new DurableConversationLog(eventStore);
  const bridgeEvents: AgentOsSessionEvent[] = [];
  const deps: DurableAgentTurnDependencies = {
    inner,
    turnRunner,
    conversationLog,
    sessionStore,
    getThreadId: (instanceId) =>
      instanceId.startsWith("discord:thread:")
        ? instanceId.slice("discord:thread:".length)
        : undefined,
    onSessionEvent: (event) => bridgeEvents.push(event),
  };
  const durable = new DurableAgentTurn(deps);
  const events: TurnEvent[] = [];
  durable.onEvent((event) => events.push(event));
  return {
    durable,
    inner,
    turnRunner,
    attemptStore,
    eventStore,
    sessionStore,
    clock,
    advance,
    events,
    bridgeEvents,
  };
}

async function getOnlyTurn(sessionStore: InMemoryAgentTurnPersistence) {
  const turns = await sessionStore.listTurnsBySession(baseInput.instanceId);
  expect(turns).toHaveLength(1);
  return turns[0]!;
}

function waitForTerminal(durable: DurableAgentTurn): Promise<TurnEvent> {
  return new Promise((resolve) => {
    const unsubscribe = durable.onEvent((event) => {
      if (event.type === "terminal") {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

describe("DurableAgentTurn", () => {
  it("creates a session and turn record on the first prompt", async () => {
    const { durable, sessionStore } = createDurableTurn();

    const result = await durable.prompt(baseInput);

    expect(result).toEqual({ accepted: true });
    const session = await sessionStore.getSession(baseInput.instanceId);
    expect(session).toMatchObject({
      agent_instance_id: baseInput.instanceId,
      role: "coding",
      repo: baseInput.repo,
      branch: baseInput.baseBranch,
      workspace_path: baseInput.workspacePath,
      setup_profile_revision: baseInput.setupProfileRevision,
      status: "active",
    });
    const turns = await sessionStore.listTurnsBySession(baseInput.instanceId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      agent_instance_id: baseInput.instanceId,
      role: "coding",
      status: "running",
      idempotency_key: baseInput.instanceId,
    });
    expect(turns[0]?.instruction_hash).toMatch(/^hash-/);
  });

  it("emits turnStarted with the durable turn and attempt ids", async () => {
    const { durable, events } = createDurableTurn();

    await durable.prompt(baseInput);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turnStarted",
      instanceId: baseInput.instanceId,
    });
    expect(events[0]).toHaveProperty("turnId");
    expect(events[0]).toHaveProperty("attemptId");
  });

  it("starts a durable attempt via TurnRunner and records the active attempt id", async () => {
    const { durable, attemptStore, sessionStore } = createDurableTurn();

    await durable.prompt(baseInput);

    const turn = await getOnlyTurn(sessionStore);
    const attempts = await attemptStore.listByTurnId(turn.turn_id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      turn_id: turn.turn_id,
      attempt_number: 1,
      status: "active",
      lease_owner: "test-worker",
    });
    expect(turn.active_attempt_id).toBe(attempts[0]?.attempt_id);
  });

  it("records discord_message_id for task turns", async () => {
    const { durable, sessionStore } = createDurableTurn();
    const input = { ...baseInput, idempotencyKey: "msg-123" };

    await durable.prompt(input);

    const turn = await getOnlyTurn(sessionStore);
    expect(turn.discord_message_id).toBe("msg-123");
    expect(turn.idempotency_key).toBe("msg-123");
  });

  it("deduplicates a prompt with the same idempotency key", async () => {
    const { durable, sessionStore } = createDurableTurn();
    const input = { ...baseInput, idempotencyKey: "msg-dup" };

    const first = await durable.prompt(input);
    const second = await durable.prompt(input);

    expect(first).toEqual({ accepted: true });
    expect(second).toEqual({ accepted: true });
    const turns = await sessionStore.listTurnsBySession(baseInput.instanceId);
    expect(turns).toHaveLength(1);
  });

  it("appends detailed session events to the ConversationLog", async () => {
    const { durable, eventStore, inner } = createDurableTurn();

    await durable.prompt(baseInput);
    await durable.onSessionEvent({
      type: "text_delta",
      instanceId: baseInput.instanceId,
      delta: "hello",
    });

    const events = await eventStore.listBySessionId(baseInput.instanceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session_id: baseInput.instanceId,
      event_kind: "text_delta",
      payload: { delta: "hello" },
      seq: 1,
      attempt_seq: 1,
      superseded: false,
    });

    inner.complete(baseInput.instanceId);
  });

  it("marks the turn and attempt terminal when the inner turn completes", async () => {
    const { durable, inner, attemptStore, sessionStore } = createDurableTurn();

    await durable.prompt(baseInput);
    const turn = await getOnlyTurn(sessionStore);
    const terminalPromise = waitForTerminal(durable);
    inner.complete(baseInput.instanceId);
    const terminal = await terminalPromise;

    expect(terminal).toMatchObject({
      type: "terminal",
      instanceId: baseInput.instanceId,
      outcome: "completed",
    });
    const attempts = await attemptStore.listByTurnId(turn.turn_id);
    expect(attempts[0]?.status).toBe("completed");
    const updated = await sessionStore.getTurn(turn.turn_id);
    expect(updated?.status).toBe("completed");
    expect(updated?.terminal_at).not.toBeNull();
    expect(updated?.active_attempt_id).toBeNull();
  });

  it("reuses the existing agent_sessions row for a follow-up turn", async () => {
    const { durable, inner, sessionStore } = createDurableTurn();

    await durable.prompt(baseInput);
    let done = waitForTerminal(durable);
    inner.complete(baseInput.instanceId);
    await done;
    await durable.prompt({ ...baseInput, instruction: "Follow up", idempotencyKey: "msg-followup" });

    const session = await sessionStore.getSession(baseInput.instanceId);
    const turns = await sessionStore.listTurnsBySession(baseInput.instanceId);
    expect(turns).toHaveLength(2);
    expect(session).toBeDefined();
  });

  it("rebuilds the transcript for a follow-up from canonical events", async () => {
    const { durable, inner, eventStore } = createDurableTurn();

    await durable.prompt(baseInput);
    await durable.onSessionEvent({
      type: "text_delta",
      instanceId: baseInput.instanceId,
      delta: "first turn output",
    });
    let done = waitForTerminal(durable);
    inner.complete(baseInput.instanceId);
    await done;

    await durable.prompt({ ...baseInput, instruction: "Follow up", idempotencyKey: "msg-followup-2" });

    const events = await eventStore.listBySessionId(baseInput.instanceId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ delta: "first turn output" });
  });

  it("passes the reconstructed transcript to the inner turn on follow-up", async () => {
    const { durable, inner } = createDurableTurn();

    await durable.prompt(baseInput);
    await durable.onSessionEvent({
      type: "text_delta",
      instanceId: baseInput.instanceId,
      delta: "first turn output",
    });
    let done = waitForTerminal(durable);
    inner.complete(baseInput.instanceId);
    await done;

    await durable.prompt({ ...baseInput, instruction: "Follow up", idempotencyKey: "msg-transcript" });
    const followUpInput = inner.prompted[inner.prompted.length - 1];
    expect(followUpInput?.transcript).toContain("first turn output");
  });

  it("records only env var names, not values, on the session", async () => {
    const { durable, sessionStore } = createDurableTurn();
    const input = { ...baseInput, env: { ANTHROPIC_API_KEY: "secret-key-123" } };

    await durable.prompt(input);

    const session = await sessionStore.getSession(baseInput.instanceId);
    expect(session?.env_names).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(session)).not.toContain("secret-key-123");
  });

  it("reconciles an interrupted attempt after restart and notifies the thread", async () => {
    const { durable, advance, sessionStore, attemptStore } = createDurableTurn();
    const notifications: { threadId: string; content: string }[] = [];

    await durable.prompt(baseInput);
    const turn = await getOnlyTurn(sessionStore);
    advance(120_001);
    await durable.resumeAfterRestart(async (threadId, content) => {
      notifications.push({ threadId, content });
    });

    const attempts = await attemptStore.listByTurnId(turn.turn_id);
    expect(attempts[0]?.status).toBe("interrupted");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      threadId: "thread-1",
      content: expect.stringContaining("Resumed after restart"),
    });
  });

  it("does not replay an interrupted prompt during resumeAfterRestart", async () => {
    const { durable, inner, advance } = createDurableTurn();

    await durable.prompt(baseInput);
    advance(120_001);
    await durable.resumeAfterRestart(async () => {});

    expect(inner.prompted).toHaveLength(1);
  });

  it("retry marks failed attempt events superseded and starts a new attempt", async () => {
    const { durable, attemptStore, eventStore, sessionStore, inner } = createDurableTurn();

    await durable.prompt(baseInput);
    const turn = await getOnlyTurn(sessionStore);
    await durable.onSessionEvent({
      type: "text_delta",
      instanceId: baseInput.instanceId,
      delta: "stale",
    });

    const retry = await durable.retryTurn(baseInput.instanceId, "provider_transient", {
      sideEffectOccurred: false,
    });
    expect(retry.accepted).toBe(true);

    const events = await eventStore.listBySessionId(baseInput.instanceId);
    expect(events).toHaveLength(1);
    expect(events[0]?.superseded).toBe(true);

    const attempts = await attemptStore.listByTurnId(turn.turn_id);
    expect(attempts.map((a) => a.attempt_number)).toEqual([1, 2]);
    expect(attempts[1]?.status).toBe("active");

    inner.fail(baseInput.instanceId, "retry test failure");
  });
});
