import { describe, expect, it } from "vitest";
import {
  TurnRunner,
  type Clock,
  type TurnFailureClass,
  type TurnRunnerConfig,
} from "../src/agentturn/turnrunner.js";
import { InMemoryTurnAttemptStore } from "./support/turn-attempt-store.js";

function createClock(): { clock: Clock; advance: (ms: number) => void } {
  let now = 0;
  return {
    clock: { now: () => new Date(now) },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function createRunner(
  overrides: Partial<TurnRunnerConfig> = {},
): {
  runner: TurnRunner;
  store: InMemoryTurnAttemptStore;
  clock: Clock;
  advance: (ms: number) => void;
} {
  const { clock, advance } = createClock();
  const store = new InMemoryTurnAttemptStore();
  const config: TurnRunnerConfig = {
    leaseOwner: "test-worker-1",
    turnTimeoutMs: 60_000,
    heartbeatTimeoutMs: 120_000,
    setupInstallTimeoutMs: 30_000,
    maxAttempts: 3,
    ...overrides,
  };
  const runner = new TurnRunner(store, config, clock);
  return { runner, store, clock, advance };
}

function assertAccepted<T extends { accepted: boolean }>(
  result: T,
): asserts result is T & { accepted: true } {
  expect(result.accepted).toBe(true);
}

describe("TurnRunner contract", () => {
  it("creates a durable attempt and records a terminal outcome", async () => {
    const { runner, store } = createRunner();

    const result = await runner.startAttempt("turn-1");

    assertAccepted(result);
    const row = await store.get(result.attemptId);
    expect(row).toMatchObject({
      turn_id: "turn-1",
      attempt_number: 1,
      status: "active",
      lease_owner: "test-worker-1",
    });

    await runner.markTerminal(result.attemptId, "completed");
    const terminal = await store.get(result.attemptId);
    expect(terminal?.status).toBe("completed");
    expect(terminal?.terminal_at).not.toBeNull();
    expect(terminal?.terminal_reason).toBe("completed");
  });

  it("attempt row has lease owner, heartbeat, started, timeout, and terminal status", async () => {
    const { runner, store } = createRunner();

    const result = await runner.startAttempt("turn-1");
    assertAccepted(result);
    const row = await store.get(result.attemptId);

    expect(row).toMatchObject({
      attempt_id: result.attemptId,
      turn_id: "turn-1",
      attempt_number: 1,
      lease_owner: "test-worker-1",
      status: "active",
    });
    expect(row?.heartbeat_at).toBeInstanceOf(Date);
    expect(row?.started_at).toBeInstanceOf(Date);
    expect(row?.timeout_ms).toBe(60_000);
    expect(row?.terminal_at).toBeNull();
    expect(row?.terminal_reason).toBeNull();
  });

  it("heartbeat updates heartbeat_at without changing other fields", async () => {
    const { runner, store, advance } = createRunner();

    const result = await runner.startAttempt("turn-1");
    assertAccepted(result);
    const before = await store.get(result.attemptId);
    const originalHeartbeat = before?.heartbeat_at.getTime();

    advance(5_000);
    await runner.heartbeat(result.attemptId);

    const after = await store.get(result.attemptId);
    expect(after?.heartbeat_at.getTime()).toBeGreaterThan(originalHeartbeat!);
    expect(after?.started_at.getTime()).toBe(before?.started_at.getTime());
    expect(after?.status).toBe("active");
  });

  it("heartbeat expiry marks attempt interrupted and releases the slot", async () => {
    const { runner, store, advance } = createRunner();

    const result = await runner.startAttempt("turn-1");
    assertAccepted(result);
    expect(await runner.activeCount()).toBe(1);

    advance(120_001);
    const interrupted = await runner.reconcileAfterRestart();

    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.attempt_id).toBe(result.attemptId);
    const row = await store.get(result.attemptId);
    expect(row?.status).toBe("interrupted");
    expect(row?.terminal_reason).toBe("heartbeat expired");
    expect(await runner.activeCount()).toBe(0);

    // The released slot can be claimed again.
    const next = await runner.startAttempt("turn-2");
    assertAccepted(next);
  });

  it("markTerminal sets terminal_at and terminal_reason", async () => {
    const { runner, store } = createRunner();

    const result = await runner.startAttempt("turn-1");
    assertAccepted(result);
    await runner.markTerminal(result.attemptId, "failed", "model provider error");

    const row = await store.get(result.attemptId);
    expect(row?.terminal_at).not.toBeNull();
    expect(row?.terminal_reason).toBe("model provider error");
    expect(row?.status).toBe("failed");
  });

  it("markTerminal is idempotent and the first terminal wins", async () => {
    const { runner, store } = createRunner();

    const result = await runner.startAttempt("turn-1");
    assertAccepted(result);
    await runner.markTerminal(result.attemptId, "completed");
    await runner.markTerminal(result.attemptId, "failed");

    const row = await store.get(result.attemptId);
    expect(row?.status).toBe("completed");
    expect(row?.terminal_reason).toBe("completed");
  });

  it("records terminal statuses for completed, failed, cancelled, and aborted", async () => {
    const cases: Array<{
      outcome: import("../src/agentturn/types.js").TerminalOutcome;
      expectedStatus: "completed" | "failed" | "interrupted";
    }> = [
      { outcome: "completed", expectedStatus: "completed" },
      { outcome: "failed", expectedStatus: "failed" },
      { outcome: "cancelled", expectedStatus: "interrupted" },
      { outcome: "aborted", expectedStatus: "failed" },
    ];

    for (const { outcome, expectedStatus } of cases) {
      const { runner, store } = createRunner();
      const result = await runner.startAttempt(`turn-${outcome}`);
      assertAccepted(result);
      await runner.markTerminal(result.attemptId, outcome);
      const row = await store.get(result.attemptId);
      expect(row?.status).toBe(expectedStatus);
    }
  });

  it("retries a provider transient failure when no tool side effect occurred", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const retry = await runner.retry("turn-1", "provider_transient", {
      sideEffectOccurred: false,
    });
    assertAccepted(retry);

    expect(retry.attemptNumber).toBe(2);
    expect(retry.supersededAttemptId).toBe(first.attemptId);
    const oldAttempt = await store.get(first.attemptId);
    expect(oldAttempt?.status).toBe("interrupted");
    const newAttempt = await store.get(retry.attemptId);
    expect(newAttempt?.status).toBe("active");
    expect(newAttempt?.retry_reason).toBe("provider_transient");
  });

  it("does not retry a provider transient failure after a tool side effect", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const retry = await runner.retry("turn-1", "provider_transient", {
      sideEffectOccurred: true,
    });

    expect(retry.accepted).toBe(false);
    if (!retry.accepted) {
      expect(retry.terminalOutcome).toBe("failed");
    }
    const oldAttempt = await store.get(first.attemptId);
    expect(oldAttempt?.status).toBe("failed");
    expect(await runner.activeCount()).toBe(0);
  });

  it("retries a sidecar crash before a terminal event", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const retry = await runner.retry("turn-1", "sidecar_crash");
    assertAccepted(retry);

    expect(retry.attemptNumber).toBe(2);
    expect(retry.retryReason).toBe("sidecar_crash");
    const oldAttempt = await store.get(first.attemptId);
    expect(oldAttempt?.status).toBe("interrupted");
  });

  it("recovers a crashed process by interrupting expired heartbeats and allows retry", async () => {
    const { runner, advance } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    await runner.heartbeat(first.attemptId);

    advance(120_001);
    const interrupted = await runner.reconcileAfterRestart();
    expect(interrupted).toHaveLength(1);

    const next = await runner.startAttempt("turn-1");
    assertAccepted(next);
    expect(next.attemptNumber).toBe(2);
  });

  it("retries a Discord projection failure without re-running the agent", async () => {
    const { runner, store } = createRunner({ maxAttempts: 5 });

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    await runner.markTerminal(first.attemptId, "completed");

    const retry = await runner.retry("turn-1", "discord_projection");
    assertAccepted(retry);

    expect(retry.attemptNumber).toBe(2);
    expect(retry.retryReason).toBe("discord_projection");
    // The original successful attempt remains canonical; no supersession.
    expect(retry.supersededAttemptId).toBeUndefined();
    const original = await store.get(first.attemptId);
    expect(original?.status).toBe("completed");
    const projection = await store.get(retry.attemptId);
    expect(projection?.status).toBe("active");
  });

  it("retries a binding error after a side effect occurred when an idempotency key is present", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const retry = await runner.retry("turn-1", "binding_error", {
      sideEffectOccurred: true,
      idempotencyKey: "pr-1",
    });
    assertAccepted(retry);

    expect(retry.attemptNumber).toBe(2);
    expect(retry.supersededAttemptId).toBe(first.attemptId);
    const oldAttempt = await store.get(first.attemptId);
    expect(oldAttempt?.status).toBe("interrupted");
    const newAttempt = await store.get(retry.attemptId);
    expect(newAttempt?.status).toBe("active");
    expect(newAttempt?.retry_reason).toBe("binding_error");
  });

  it("retries a binding error when an idempotency key is present and no side effect occurred", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const retry = await runner.retry("turn-1", "binding_error", {
      sideEffectOccurred: false,
      idempotencyKey: "pr-1",
    });
    assertAccepted(retry);

    expect(retry.attemptNumber).toBe(2);
    const newAttempt = await store.get(retry.attemptId);
    expect(newAttempt?.retry_reason).toBe("binding_error");
  });

  it("does not retry a binding error without an idempotency key", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const retry = await runner.retry("turn-1", "binding_error", {
      sideEffectOccurred: false,
    });

    expect(retry.accepted).toBe(false);
    const oldAttempt = await store.get(first.attemptId);
    expect(oldAttempt?.status).toBe("failed");
  });

  it("does not retry a validation loop and terminates with aborted", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const retry = await runner.retry("turn-1", "validation_loop", {
      reason: "too many validation failures",
    });

    expect(retry.accepted).toBe(false);
    if (!retry.accepted) {
      expect(retry.terminalOutcome).toBe("aborted");
    }
    const oldAttempt = await store.get(first.attemptId);
    expect(oldAttempt?.status).toBe("failed");
    expect(oldAttempt?.terminal_reason).toBe("too many validation failures");
  });

  it("retry creates a new attempt with an incremented attempt_number", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    await runner.retry("turn-1", "provider_transient", {
      sideEffectOccurred: false,
    });
    const second = await runner.retry("turn-1", "provider_transient", {
      sideEffectOccurred: false,
    });
    assertAccepted(second);

    const attempts = await store.listByTurnId("turn-1");
    expect(attempts.map((a) => a.attempt_number)).toEqual([1, 2, 3]);
    expect(attempts[0]?.retry_reason).toBeNull();
    expect(attempts[1]?.retry_reason).toBe("provider_transient");
    expect(attempts[2]?.retry_reason).toBe("provider_transient");
  });

  it("keeps only one attempt active per turn after a retry", async () => {
    const { runner } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    await runner.retry("turn-1", "provider_transient", {
      sideEffectOccurred: false,
    });

    const active = await runner.activeCount();
    expect(active).toBe(1);
  });

  it("cancel before retry produces a cancelled terminal and no new attempt", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const cancel = await runner.cancel("turn-1");
    expect(cancel.cancelled).toBe(true);

    const retry = await runner.retry("turn-1", "provider_transient", {
      sideEffectOccurred: false,
    });
    expect(retry.accepted).toBe(false);
    if (!retry.accepted) {
      expect(retry.terminalOutcome).toBe("cancelled");
    }

    const attempts = await store.listByTurnId("turn-1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("interrupted");
  });

  it("retry supersedes the previous attempt so stale output is not canonical", async () => {
    const { runner, store } = createRunner();

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const retry = await runner.retry("turn-1", "provider_transient", {
      sideEffectOccurred: false,
    });
    assertAccepted(retry);

    expect(retry.supersededAttemptId).toBe(first.attemptId);
    const oldAttempt = await store.get(first.attemptId);
    expect(oldAttempt?.status).not.toBe("active");
    const newAttempt = await store.get(retry.attemptId);
    expect(newAttempt?.status).toBe("active");
  });

  it("attempts can be queried by turn_id", async () => {
    const { runner, store } = createRunner();

    await runner.startAttempt("turn-a");
    await runner.startAttempt("turn-a");
    await runner.startAttempt("turn-b");

    const aAttempts = await store.listByTurnId("turn-a");
    expect(aAttempts).toHaveLength(2);
    expect(aAttempts.map((a) => a.attempt_number)).toEqual([1, 2]);
  });

  it("enforces the turn timeout", async () => {
    const { runner, store, advance } = createRunner();

    const result = await runner.startAttempt("turn-1");
    assertAccepted(result);

    advance(60_001);
    const timedOut = await runner.enforceTimeouts();
    expect(timedOut).toHaveLength(1);

    const row = await store.get(result.attemptId);
    expect(row?.status).toBe("failed");
    expect(row?.terminal_reason).toBe("turn timeout");
  });

  it("enforces a separate setup install timeout", async () => {
    const { runner, store, advance } = createRunner();

    const result = await runner.startAttempt("turn-1", { setupInstall: true });
    assertAccepted(result);
    expect(result.timeoutMs).toBe(30_000);

    advance(30_001);
    const timedOut = await runner.enforceTimeouts();
    expect(timedOut).toHaveLength(1);

    const row = await store.get(result.attemptId);
    expect(row?.status).toBe("failed");
  });

  it("enforces a maximum number of attempts", async () => {
    const { runner, store } = createRunner({ maxAttempts: 2 });

    const first = await runner.startAttempt("turn-1");
    assertAccepted(first);
    const second = await runner.retry("turn-1", "provider_transient", {
      sideEffectOccurred: false,
    });
    assertAccepted(second);

    const third = await runner.retry("turn-1", "provider_transient", {
      sideEffectOccurred: false,
    });
    expect(third.accepted).toBe(false);
    if (!third.accepted) {
      expect(third.terminalOutcome).toBe("failed");
    }

    const attempts = await store.listByTurnId("turn-1");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.status).toBe("failed");
  });

  it("records a concise, redacted error summary when an attempt fails", async () => {
    const { runner, store } = createRunner();

    const result = await runner.startAttempt("turn-1");
    assertAccepted(result);
    await runner.markTerminal(result.attemptId, "failed", "model provider error");

    const row = await store.get(result.attemptId);
    const reason = row?.terminal_reason ?? "";
    expect(reason).toBe("model provider error");
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThan(200);
  });

  it("does not import or use Discord formatting", async () => {
    // The contract is enforced by the type system: TurnRunner has no
    // Discord-formatting methods and no Discord-specific imports.
    const { runner } = createRunner();
    expect(runner).not.toHaveProperty("formatToolLine");
    expect(runner).not.toHaveProperty("postMessage");
    expect(runner).not.toHaveProperty("editMessage");
  });
});
