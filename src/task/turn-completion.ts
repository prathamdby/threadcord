/**
 * In-process completion bridge between pg-boss turn jobs and Flue observe events.
 *
 * The turn executor registers a deferred wait BEFORE dispatching a Flue agent
 * turn. When the observe-bridge fires `agent_end` or `agent_failure`, the
 * orchestrator resolves the deferred so the executor can settle the turn row
 * and task status. After a crash there is nothing to restore: pg-boss
 * redelivery reconstructs the wait (see turn-executor's resume path).
 *
 * The map is intentionally module-level and in-process only, modelled on
 * `src/discord/user-turn-message.ts`.
 */

export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; errorSummary: string }
  | { kind: "cancelled" };

interface Deferred {
  promise: Promise<TurnOutcome>;
  resolve: (outcome: TurnOutcome) => void;
}

const waiters = new Map<string /* flueInstanceId */, Deferred>();

/**
 * Create (or return the existing) deferred wait for a Flue instance's turn
 * outcome. Must be called BEFORE dispatch so a fast agent cannot finish before
 * the waiter exists.
 */
export function waitForTurnOutcome(instanceId: string): Promise<TurnOutcome> {
  const existing = waiters.get(instanceId);
  if (existing) return existing.promise;

  let resolve!: (outcome: TurnOutcome) => void;
  const promise = new Promise<TurnOutcome>((r) => {
    resolve = r;
  });
  waiters.set(instanceId, { promise, resolve });
  return promise;
}

/**
 * Resolve the deferred wait and delete the entry. A no-op when no waiter is
 * registered (a late `agent_end` after abort must not throw).
 */
export function resolveTurnOutcome(
  instanceId: string,
  outcome: TurnOutcome,
): void {
  const deferred = waiters.get(instanceId);
  if (!deferred) return;
  waiters.delete(instanceId);
  deferred.resolve(outcome);
}

/** Delete the waiter without resolving (used by tests and shutdown). */
export function clearTurnWaiter(instanceId: string): void {
  waiters.delete(instanceId);
}
