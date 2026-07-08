# Plan 004: Cancellation, restart recovery, retention, and legacy scheduler removal

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6cba1de..HEAD -- src/task/abort-thread-task.ts src/task/janitor.ts src/task/store.ts src/task/orchestrator.ts`
> Changes from plans 001-003 are expected. Any drift beyond them in
> `abort-thread-task.ts` or `janitor.ts`: compare against the "Current state"
> excerpts; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/003-turn-executor-switchover.md
- **Category**: tech-debt (queue durability refactor, part 4 of 4)
- **Planned at**: commit `6cba1de`, 2026-07-08

## Why this matters

After plan 003, turns run through pg-boss but three legacy behaviors remain: cancellation does not gate the new turn rows or cancel queued pg-boss jobs; restart recovery still mass-demotes every `running` task to `waiting` (`releaseRunningAfterRestart`, `src/task/store.ts:401-410`) and then strands it until a human sends a follow-up; and terminal `task_turns` rows accumulate forever. This plan closes all three and deletes the now-dead legacy scheduler, turning restarts from "wait for a human" into "interrupted turns automatically requeue".

## Current state

Verified at `6cba1de`; plan-003 refactors noted inline.

- `src/task/abort-thread-task.ts:35-63` — `stopTaskWork(task, deps, { abortInFlight })`: `store.cancelTask(task.id)` (guarded UPDATE to `cancelled` + `DELETE FROM task_followups`, `src/task/store.ts:375-391`) → `clearPendingUserTurnMessage` → if abort, `abortAgentWorkForInstance(flueInstanceId)` → `clearInFlight` → reaction flips → `deleteTaskThread` → `fillConcurrencySlots()`.
- `src/task/orchestrator.ts:520-575` — `executeThreadControl`: `abort`/`cancel` route to `stopTaskWork`; `done` is `transition(taskId, ["waiting","queued"], "completed")`.
- `src/task/orchestrator.ts:192-213` — `resumeAfterRestart(notifyThread)`: `releaseRunningAfterRestart()` → per-task header refresh + "Resumed after restart. Ready for the next instruction." notification (per-task try/catch) → `failAbandonedDrafts()` → `fillConcurrencySlots()`.
- `src/task/janitor.ts` (25 lines) — `startWorkspaceJanitor` `setInterval` (6h default), each tick `listExpiredWorkspacePaths(ttlDays)` then `rm -rf` each path; returns the interval handle; `src/app.ts` `shutdown` calls `clearInterval(janitor)`.
- Legacy store surface going dead after plan 003: `claimNextTurn`, `claimInitialTurn`, `claimFollowupTurn`, `enqueueFollowup`, `releaseRunningAfterRestart`, `SCHEDULER_LOCK_KEY`, plus `fillConcurrencySlots` in the orchestrator and `initial_turn_started` usage.

### Reference pattern (pr-agent, inline)

Releasing a singleton key by cancelling its jobs (pr-agent `singletonQueue.ts` — note: per-job `boss.cancel`, there is no cancel-by-key API):

```ts
const jobs = await boss.findJobs(queue, { key: singletonKey });
for (const job of jobs) {
  const state = job.state as string;
  if (state === "cancelled" || state === "completed" || state === "failed") continue;
  await boss.cancel(queue, job.id);
}
```

Retention loop (pr-agent `retention.ts`): batched `DELETE ... LIMIT batch` in a loop, each batch its own implicit transaction; stop when a batch deletes fewer than `batchSize` rows.

## Commands you will need

| Purpose   | Command         | Expected on success |
|-----------|-----------------|---------------------|
| Typecheck | `npm run check` | exit 0 |
| Tests     | `npm test`      | exit 0, all pass |
| Build     | `npm run build` | exit 0 (Node >=22.18) |

## Scope

**In scope**:
- `src/task/abort-thread-task.ts`, `src/task/orchestrator.ts`, `src/task/store.ts`, `src/task/turn-store.ts` (additions only), `src/task/janitor.ts`, `src/task/boss.ts` (add `releaseTaskSingleton` helper), `src/app.ts`, `src/types.ts` (drop `initialTurnStarted` if unused)
- Tests: `test/task-thread-controls.test.ts`, `test/task-admission.test.ts` (restart cases), `test/support/orchestrator-harness.ts`, new `test/turn-recovery.test.ts`, new `test/turn-retention.test.ts`

**Out of scope**:
- `src/setup/**`, `src/mcp/**`, `src/discord/ui/**`, `src/agents/**`.
- The `tasks` table columns (`initial_turn_started` column stays in the DB — dropping columns on a deployed DB is not worth the risk; only code references go).
- Discord-facing copy changes beyond the one new restart message in Step 2.

## Git workflow

- Branch: `pd/refactor/pgboss-queue` (continue).
- Commits per step-cluster; conventional style, e.g. `feat: pg-boss cancellation and restart recovery`, `refactor: remove legacy advisory-lock scheduler`.
- Do NOT push unless instructed.

## Steps

### Step 1: Cancellation through the turn gate

Add `releaseTaskSingleton(boss, taskId)` to `src/task/boss.ts` implementing the reference pattern (queue = `TASK_TURN_QUEUE`, key = taskId). Rewire `stopTaskWork` to, in order:

1. `store.cancelTask(task.id)` (unchanged guard; also delete its `DELETE FROM task_followups` statement once Step 4 removes the table's writers — keep the delete until then).
2. For the active turn: `turnStore.requestCancel` on any `running` turn of the task, and `turnStore.cancelPendingTurnsForTask(task.id)` for queued ones.
3. `await releaseTaskSingleton(boss, task.id)` — cancels the queued/active pg-boss jobs.
4. If `abortInFlight`: `await abortAgentWorkForInstance(flueInstanceId)` FIRST, then `resolveTurnOutcome(flueInstanceId, { kind: "cancelled" })`. Order matters: abort kills the Flue submission so its late `agent_end` is suppressed by the existing operator-abort marker; resolving first would let the executor settle while Flue still runs.
5. Existing cleanup (clear pending messages, reactions, thread ref) unchanged; drop the trailing `fillConcurrencySlots()`.

`done` in `executeThreadControl` additionally calls `cancelPendingTurnsForTask` + `releaseTaskSingleton` (a completed task must not have queued turns fire later).

**Verify**: `npm test -- task-thread-controls` → suite passes with updated assertions (see Test plan).

### Step 2: Restart recovery — requeue instead of strand

Replace the internals of `resumeAfterRestart` (public signature unchanged):

1. Query turns stuck `running`: add `TurnStore.listRunningTurns(): Promise<TaskTurnRecord[]>`.
2. For each: the process just started, so no Flue submission is live. `releaseTaskSingleton(boss, taskId)` (clears the dead job blocking the FIFO key), then reset the turn: `UPDATE task_turns SET status='queued', updated_at=now() WHERE id=$1 AND status='running'` (add `TurnStore.requeueInterruptedTurn(turnId): Promise<boolean>`; attempt_count intentionally preserved), then task `transition(taskId, "running", "queued")`, then a fresh transactional `boss.send` (same shape as plan 003 intake) for the turn id.
3. Notify the thread: "Restart detected. The interrupted turn was requeued." (replaces the old "Ready for the next instruction." message), keeping the per-task try/catch so one bad thread does not block the rest — that behavior is pinned by `test/task-admission.test.ts:255-319`.
4. Also enqueue jobs for any `queued` turns that have no boss job (covers plan 003's backfilled follow-ups): `boss.findJobs(TASK_TURN_QUEUE, { key: taskId })` and send for turns not represented. Keep `failAbandonedDrafts()` at the end, unchanged.
5. Delete the `releaseRunningAfterRestart` call (and its store method in Step 4).

**Verify**: `npm test -- task-admission` → restart-reconciliation cases pass with the updated message/flow.

### Step 3: Retention

Extend the janitor tick (`src/task/janitor.ts` `cleanup()`): after workspace removal, loop `turnStore.deleteAgedTerminalTurns(config.TURN_RETENTION_DAYS, 5000)` until a batch returns < 5000. The janitor stays a `setInterval` (decision: threadcord already has this maintenance loop; a pg-boss cron queue would add a moving part for no gain — pg-boss's own job-table cleanup is already handled by `supervise` + the queue's `retentionSeconds`/`deleteAfterSeconds` from plan 001). `startWorkspaceJanitor` gains a `turnStore` + `turnRetentionDays` arg; `src/app.ts` passes them.

**Verify**: `npm test -- turn-retention` → new tests pass (see Test plan).

### Step 4: Delete the legacy scheduler

Remove: `TaskStore.claimNextTurn`, `claimInitialTurn`, `claimFollowupTurn`, `enqueueFollowup`, `releaseRunningAfterRestart`, `SCHEDULER_LOCK_KEY`; `TaskOrchestrator.fillConcurrencySlots` and `scheduleAfterTurn` (if plan 003 left a stub); all `initial_turn_started` reads/writes in code (`claimInitialTurn` SQL and `rowToTask`'s `initialTurnStarted` mapping + the `TaskRecord` field, if nothing else references it — check with the grep in Done criteria); the `task_followups` DDL stays in `migrate()` (existing deployments) but gains no new writers; `cancelTask` keeps its `DELETE FROM task_followups` as harmless legacy hygiene. Update `test/support/orchestrator-harness.ts`: remove `InMemoryStore.claimNextTurn`/`enqueueFollowup`/`releaseRunningAfterRestart` and the `breakNextTransition` hooks that target removed paths (keep `breakNextTransition` itself — the executor settle races still use it). Also remove the `ClaimedTurn` type from `src/types.ts` if nothing references it.

**Verify**: `npm run check` → exit 0. `npm test` → all pass.

## Test plan

- `test/task-thread-controls.test.ts` (update): confirm-abort now asserts, in order: cancelTask → requestCancel/cancelPendingTurns → boss jobs cancelled (FakeBoss records) → `abortAgentWorkForInstance` → deferred resolved cancelled. Confirm-done asserts pending turns + jobs cancelled.
- New `test/turn-recovery.test.ts` (model on the restart cases in `test/task-admission.test.ts:255-340`): (1) a running turn at boot is requeued — turn back to `queued`, same `attempt_count`, task `running→queued`, fresh boss.send, thread notified with the new message; (2) a notify failure on one task does not block the next (preserves the existing pin); (3) a queued turn with no boss job gets one.
- New `test/turn-retention.test.ts`: batching loop stops on a short batch (mirror pr-agent's invariant: exactly 2 calls when the first returns a full batch and the second a short one); only terminal statuses aged past the TTL are deleted.
- Full-suite regression: every other existing test passes unmodified.

**Verification**: `npm test` → exit 0, all suites including the 2 new files.

## Done criteria

- [ ] `npm run check` exits 0; `npm test` exits 0; `npm run build` exits 0
- [ ] `grep -rn "claimNextTurn\|claimInitialTurn\|claimFollowupTurn\|enqueueFollowup\|releaseRunningAfterRestart\|SCHEDULER_LOCK_KEY\|fillConcurrencySlots\|8675309" src/ test/` returns no matches
- [ ] `grep -rn "initial_turn_started\|initialTurnStarted" src/` returns matches only in `TaskStore.migrate()` DDL (column kept in DB, dead in code)
- [ ] `grep -rn "INSERT INTO task_followups" src/` returns no matches
- [ ] `test/turn-recovery.test.ts` and `test/turn-retention.test.ts` exist and pass
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `boss.findJobs(queue, { key })` does not exist or does not return job `state` — the singleton-release design depends on it (verified against pg-boss 12.22 usage in pr-agent).
- Removing `initialTurnStarted` from `TaskRecord` breaks more than the harness and store (some feature reads it — report where).
- The restart-requeue flow would double-dispatch in any test scenario (two boss jobs active for one task id) — the FIFO-key assumption is violated; do not paper over it with locks.
- `stopTaskWork`'s public shape (`src/task/abort-thread-task.ts:35`) cannot be preserved.

## Maintenance notes

- Restart semantics change deliberately: interrupted turns AUTO-RESUME instead of waiting for a human follow-up. If a poison instruction crash-loops the process, the retry limit (`QUEUE_RETRY_LIMIT`) is the only brake — reviewers should confirm the terminal-failure path posts to Discord.
- `task_followups` is retained as a dead table for one release; a future plan may drop it (and the `initial_turn_started` column) once a deployment has run this code.
- Abort-then-resolve ordering in Step 1.4 is load-bearing; swapping it reintroduces the late-agent_end race.
