# Plan 003: Switch scheduling to pg-boss — transactional intake, turn executor, and the Flue completion bridge

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6cba1de..HEAD -- src/task/orchestrator.ts src/task/store.ts src/app.ts src/discord/observe-bridge.ts`
> Changes from plans 001/002 are expected (db.ts, config.ts, boss.ts, turn-store.ts,
> the migrate() append). Any OTHER drift in the files above: compare the
> "Current state" excerpts against live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH (the switchover; the completion bridge is novel surface)
- **Depends on**: plans/001-pgboss-foundation.md, plans/002-task-turns-schema.md
- **Category**: tech-debt (queue durability refactor, part 3 of 4)
- **Planned at**: commit `6cba1de`, 2026-07-08

## Why this matters

This is the switchover: turns stop flowing through `claimNextTurn`'s advisory-lock scheduler and start flowing through pg-boss. Two properties are gained that the current design cannot express: (1) transient turn failures (git clone hiccup, network blip) retry with backoff instead of permanently failing the task — today ANY throw in `runTurn` lands in the catch block at `src/task/orchestrator.ts:745-763` which transitions the task to `failed` with no retry; (2) enqueue and job delivery become atomic — a turn row and its pg-boss job commit in one transaction, so "row exists but no job" and "job exists but no row" become impossible.

## Current state

All excerpts verified at commit `6cba1de`.

- `src/task/orchestrator.ts:98-102` — `dispatchTurn` is a constructor-injected type, NOT a module function:
  ```ts
  export type DispatchTurn = (instanceId: string, input: DispatchAgentInput) => Promise<void>;
  ```
  Default (`orchestrator.ts:143-145`): `await dispatch(codingAgent, { id: instanceId, input })`. Fire-and-forget: it resolves when the turn is ACCEPTED, not when it finishes. Turn completion arrives later as observe-bridge events.
- `src/app.ts:76-91` — observe-bridge wiring: `onAgentEnd`/`onAgentFailure` callbacks first offer the event to `setupOrchestrator`, then fall through to `orchestrator.handleAgentEnd(instanceId)` / `handleAgentFailure(instanceId, errorSummary)`.
- `src/task/orchestrator.ts:581-613` — `handleAgentEnd`: transitions task `running→waiting` (guarded; a lost race means a concurrent cancel won), drains pending user-turn messages (`takePendingUserTurnMessages` from `src/discord/user-turn-message.ts`), refreshes the header, flips the initiator reaction to ✅, then `scheduleAfterTurn(task.id)`.
- `src/task/orchestrator.ts:615-645` — `handleAgentFailure`: transitions `running→failed`, posts `failureDiscordMessage`, flips ❌, `fillConcurrencySlots()`.
- `src/task/orchestrator.ts:648-663` — `scheduleAfterTurn` + `fillConcurrencySlots` loop `store.claimNextTurn()`.
- `src/task/orchestrator.ts:664-763` — `runTurn(claimed)`: bootstrap → setup install (initial only) → re-check status → build prompt → `this.dispatchTurn(...)` → typing loop → "Agent turn accepted." post; catch = permanent fail.
- `src/task/store.ts:288-330` — `claimNextTurn` (advisory lock `8675309`, running-count cap `maxConcurrentTasks`, prefer-followup → prefer-initial → global-followup). Replaced by this plan, deleted in plan 004.
- `src/task/store.ts:413-440` — `enqueueFollowup` (INSERT into `task_followups` + position count). Replaced here, deleted in plan 004.
- `src/task/store.ts:332-346` — `queueSnapshot(taskId)` computes position/depth over `tasks WHERE status='queued'`. It is TASK-level and stays correct unchanged, because task-status semantics are preserved (below).
- Task status machine (PRESERVE EXACTLY): `draft → queued` (attach), `queued → running` (first turn starts), `running → waiting` (turn ends), `waiting → running` (follow-up turn starts), `running → failed`, `{queued,waiting,running} → cancelled`, `{waiting,queued} → completed` (done). All via `store.transition()` (`src/task/store.ts:354-372`), which returns the row or `undefined` on a lost race.
- `src/flue/agent-work-abort.ts:52-91` — `abortAgentWorkForInstance(instanceId)`; and the liveness predicate this plan needs: `executionStore.submissions.listRunningSubmissions()` filtered by `submission.sessionKey === sessionKeyForInstance(instanceId)` (`sessionKeyForInstance` exported at `:93-95`).
- Follow-up intake: `handleThreadMessage` (`src/task/orchestrator.ts:410-486`) calls `enqueueFollowup`, and if `task.status === "waiting"` claims immediately.
- Initial intake: `admitTask` (`src/task/orchestrator.ts:318-407`): createDraft → create thread → header → instruction post → status post → `attachAndPromote` (draft→queued) → `claimNextTurn(task.id)`.

### Reference pattern (pr-agent, inline)

Atomic intake — the work-item INSERT and `boss.send` share one `PoolClient`, so they commit or roll back together:

```ts
await inTransaction(pool, async (client) => {
  await turnStore.insertTurn(turn, client);
  const jobId = await boss.send(TASK_TURN_QUEUE, data, {
    singletonKey: taskId,          // key_strict_fifo: one active turn per task, FIFO within
    db: pgBossDb(client),          // ride the same transaction
  });
  if (jobId === null) throw new Error("boss.send returned null");
});
```

Worker registration (pr-agent `worker.ts`, verified shape):

```ts
await boss.work<TurnJobData>(
  TASK_TURN_QUEUE,
  {
    localConcurrency: config.MAX_CONCURRENT_TASKS,
    heartbeatRefreshSeconds: Math.max(1, Math.floor(config.QUEUE_HEARTBEAT_SECONDS / 2)),
    includeMetadata: true,          // handler receives JobWithMetadata: retryCount, retryLimit
  },
  async ([job]) => executeTurnJob(job),
);
```

Retry classification (pr-agent `durableJob.ts`): terminal attempt = `job.retryCount >= job.retryLimit`. Non-terminal: mark the row back to queued and RETHROW so pg-boss schedules the backoff retry. Terminal: mark failed, notify, swallow.

## Commands you will need

| Purpose   | Command         | Expected on success |
|-----------|-----------------|---------------------|
| Typecheck | `npm run check` | exit 0 |
| Tests     | `npm test`      | exit 0, all pass |
| Build     | `npm run build` | exit 0 (Node >=22.18) |

## Scope

**In scope**:
- `src/task/turn-completion.ts` (create)
- `src/task/turn-executor.ts` (create)
- `src/task/orchestrator.ts` (intake rewiring, runTurn refactor, handleAgentEnd/Failure slimming)
- `src/task/store.ts` (ONLY: add the one-time `task_followups → task_turns` backfill to `migrate()`)
- `src/app.ts` (pass boss + TurnStore into the orchestrator/executor; register the worker)
- `test/support/orchestrator-harness.ts`, plus test files listed in the Test plan

**Out of scope**:
- Deleting `claimNextTurn` / `claimFollowupTurn` / `claimInitialTurn` / `enqueueFollowup` / `fillConcurrencySlots` / `releaseRunningAfterRestart` — they go dead here but are DELETED in plan 004 (keeps this diff reviewable).
- `stopTaskWork` / cancel/abort/done rewiring, restart recovery, retention — plan 004.
- `src/setup/**`, `src/mcp/**`, `src/agents/**`, `src/discord/ui/**`.

## Git workflow

- Branch: `pd/refactor/pgboss-queue` (continue).
- Commit per step-cluster (bridge, executor, intake, tests); conventional style, e.g. `feat: route task turns through pg-boss with durable turn executor`.
- Do NOT push unless instructed.

## Steps

### Step 1: The completion bridge — `src/task/turn-completion.ts`

```ts
export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; errorSummary: string }
  | { kind: "cancelled" };
```

Module-level `Map<string /* flueInstanceId */, { promise, resolve }>` with:
- `waitForTurnOutcome(instanceId): Promise<TurnOutcome>` — creates (or returns the existing) deferred and its promise.
- `resolveTurnOutcome(instanceId, outcome)` — resolves and deletes the entry; a no-op when no waiter is registered (a late `agent_end` after abort must not throw).
- `clearTurnWaiter(instanceId)` — delete without resolving (used by tests and shutdown).

The map is intentionally in-process only: after a crash there is nothing to restore — the pg-boss job redelivery (Step 4's resume path) reconstructs the wait. Model the module shape on `src/discord/user-turn-message.ts` (the existing per-instance in-memory map).

**Verify**: `npm run check` → exit 0.

### Step 2: The executor — `src/task/turn-executor.ts`

`executeTurnJob(deps, job)` where `deps` carries `{ turnStore, taskStore, orchestrator hooks, config }` and `job` is the pg-boss `JobWithMetadata<{ turnId, taskId, flueInstanceId, source }>`. Sequence:

1. **Claim**: `const turn = await turnStore.claimQueuedTurn(job.data.turnId)`. If `undefined`, fall back to `resumeTurnForExecution(turnId)`:
   - `false` → the turn is terminal or cancel-gated; log and return (job completes, no work).
   - `true` → **resume path** (redelivery of a running row). Check Flue liveness: `listRunningSubmissions()` filtered by `sessionKeyForInstance(flueInstanceId)` (import from `src/flue/agent-work-abort.ts`; the execution store may be undefined early in boot — treat "no store" as "not live"). If live: skip dispatch, go straight to Step 2.6 (await outcome). If not live: continue at 2.2 (re-dispatch).
2. **Task transition**: `taskStore.transition(taskId, ["queued", "waiting"], "running")`. A lost race here (returns `undefined`) with task already `running` is fine on the resume path; otherwise treat as cancel (mark turn cancelled, return).
3. **Prepare**: run the existing bootstrap + setup-install + prompt-build logic (move it out of `orchestrator.runTurn` into this module, injected the same way — `bootstrap`, `runSetupInstallTurn`, `dispatchTurn` remain constructor-injectable test seams). Checkpoint after bootstrap: `if (await turnStore.shouldSkipTurn(turn.id))` → `markTurnCancelled`, reconcile task (Step 3 hook), return.
4. **Dispatch**: `await deps.dispatchTurn(flueInstanceId, input)`; then typing loop + "Agent turn accepted." post (reuse the orchestrator's helpers via the hooks).
5. **Await**: `const outcome = await waitForTurnOutcome(flueInstanceId)`. IMPORTANT: register the waiter BEFORE dispatching (between 2.3 and 2.4) so a fast agent cannot finish before the waiter exists.
6. **Settle** on `outcome.kind`:
   - `completed` → `markTurnCompleted(turn.id)`; if it returns `false` a cancel won — do the cancel side-effects instead. Then task `running→waiting` transition + the post-turn side effects (drain user messages, header refresh, ✅ flip) via orchestrator hooks.
   - `cancelled` → `markTurnCancelled(turn.id)`; no task transition (the cancel path in plan 004 owns it; until then `stopTaskWork`'s `cancelTask` already set the task terminal).
   - `failed` → treat like a thrown error (next paragraph) so agent failures also get retry classification.
7. **Error handling** (wraps 2.2-2.6): on throw or `failed` outcome, `if (await turnStore.shouldSkipTurn(turn.id))` → cancelled cleanup. Else if `job.retryCount < job.retryLimit` → `markTurnRetrying(turn.id, summary)`, task `running→queued` transition (so the header shows queued during backoff), post "Turn hit an error, retrying." to the thread, RETHROW (pg-boss schedules the backoff). Else → `markTurnFailed(turn.id, summary)`, task `running→failed` with `summarizeError`, post `failureDiscordMessage`, ❌ flips — i.e. exactly today's failure block at `orchestrator.ts:745-763`, minus `fillConcurrencySlots`.

`localConcurrency: MAX_CONCURRENT_TASKS` replaces the old running-count cap; `singletonKey = taskId` with `key_strict_fifo` replaces per-task serialization and the `initial_turn_started` gate.

**Verify**: `npm run check` → exit 0.

### Step 3: Resolve the bridge from the observe callbacks

In `src/task/orchestrator.ts`:
- `handleAgentEnd(instanceId)` → body becomes: `resolveTurnOutcome(instanceId, { kind: "completed" })`. The task transition, message drain, header refresh, and reaction flip MOVE into the executor's settle step (2.6) so there is exactly one writer of turn/task state.
- `handleAgentFailure(instanceId, errorSummary)` → `resolveTurnOutcome(instanceId, { kind: "failed", errorSummary })`.
- Delete `scheduleAfterTurn`; keep `fillConcurrencySlots` compiling but unreferenced (deleted in plan 004).

**Verify**: `npm run check` → exit 0 (expect test failures until Step 6; that is fine mid-plan).

### Step 4: Transactional intake

- **Initial turn** — in `admitTask`, replace the trailing `claimNextTurn(task.id)`+`runTurn` with: after `attachAndPromote` succeeds, `inTransaction(pool, client => { insertTurn({ source: "initial", instruction, discordMessageId }, client); boss.send(TASK_TURN_QUEUE, { turnId, taskId, flueInstanceId, source: "initial" }, { singletonKey: task.id, db: pgBossDb(client) }); })`, throwing if `boss.send` returns `null` (rolls back both).
- **Follow-up** — in `handleThreadMessage`, replace `enqueueFollowup` with the same transactional insert+send (`source: "followup"`, dedupe on the Discord message id via `insertTurn`'s `ON CONFLICT`; when `created === false`, skip the send — duplicate delivery). Delete the `if (task.status === "waiting") claim...` block: pg-boss now schedules.
- The reply-quote context prefixing of the instruction (see `test/reply-quote-context.test.ts`) must keep happening BEFORE the insert, unchanged.
- **Backfill migration** — append to `TaskStore.migrate()` (idempotent; `ON CONFLICT DO NOTHING` makes re-runs safe):
  ```sql
  INSERT INTO task_turns (id, task_id, source, instruction, discord_message_id, status, created_at)
  SELECT gen_random_uuid(), f.task_id, 'followup', f.instruction, f.discord_message_id, 'queued', f.created_at
  FROM task_followups f
  JOIN tasks t ON t.id = f.task_id
  WHERE t.status IN ('queued', 'running', 'waiting')
  ON CONFLICT (discord_message_id) DO NOTHING;
  ```
  Note: backfilled turns have rows but no pg-boss jobs; plan 004's boot reconciliation enqueues jobs for orphaned queued turns, which covers them. State this in a code comment? No — put it in the commit message instead.
- **Deploy guard**: this switchover assumes no task is mid-turn during deploy. Today's restart behavior already forces that (`releaseRunningAfterRestart` demotes `running` rows on boot). No extra guard needed, but see STOP conditions.

**Verify**: `npm run check` → exit 0.

### Step 5: Wire it in `src/app.ts`

Construct `TurnStore`, pass `{ boss, turnStore }` into `TaskOrchestrator` (new constructor params, defaulted for tests), and after `ensureTaskQueues` register the worker with the options shape from the reference pattern. Keep `resumeAfterRestart` called as today (plan 004 replaces its internals).

**Verify**: `npm run check` → exit 0. `npm run build` → exit 0.

### Step 6: Rework the test harness and pinned tests

- `test/support/orchestrator-harness.ts`: extend `InMemoryStore` with an in-memory `TurnStore` double (`insertTurn`/`claimQueuedTurn`/`markTurn*`/`shouldSkipTurn` against a `Map`), and add a `FakeBoss` with `send` (records `{ queue, data, options }`, returns a fake id), `work` (captures the handler so tests can invoke `deliver(job)` manually), and `cancel`. Tests drive turns by calling `deliver` — no timers.
- Update the pinned suites to the new flow: `test/task-admission.test.ts` (admission now asserts an insertTurn+send pair instead of `claimNextTurn`), `test/reactions-typing.test.ts` (reaction/typing lifecycle now spans executor settle), `test/reply-quote-context.test.ts` (instruction reaches `insertTurn`), `test/post-thread-report.test.ts` (drain happens at settle), `test/task-channel-message.test.ts`. Preserve every behavioral assertion; only the mechanism changes.

**Verify**: `npm test` → exit 0, all suites pass.

## Test plan

New file `test/turn-executor.test.ts` (model the structure on `test/task-admission.test.ts`'s use of the harness), covering:

1. happy path: claim → dispatch → resolve completed → turn completed, task `running→waiting`, user messages drained, ✅ flipped.
2. cancel-before-claim: `requestCancel` then deliver → no dispatch, turn cancelled.
3. cancel-mid-turn: `requestCancel` after bootstrap checkpoint → no dispatch, turn cancelled.
4. retry-then-terminal: throw with `retryCount < retryLimit` → `markTurnRetrying` + rethrow + task back to `queued`; throw at `retryCount == retryLimit` → `markTurnFailed`, task `failed`, failure message posted.
5. resume-after-redelivery: deliver a job whose turn row is `running`, Flue not live → re-dispatch without attempt bump; Flue live → waits for outcome only.
6. intake atomicity: `boss.send` returning `null` inside the transaction throws and the turn insert is rolled back (assert via the FakeBoss + harness transaction stub).
7. fast-finish race: outcome resolved before the executor awaits → still settles completed (waiter registered pre-dispatch).

**Verification**: `npm test -- turn-executor` → all 7 pass; `npm test` → whole suite green.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0, including the 7 new `turn-executor` cases
- [ ] `npm run build` exits 0
- [ ] `grep -n "claimNextTurn" src/task/orchestrator.ts` returns no matches (calls removed; store method itself still exists until plan 004)
- [ ] `grep -n "enqueueFollowup" src/task/orchestrator.ts` returns no matches
- [ ] `grep -n "waitForTurnOutcome" src/task/turn-executor.ts` shows the waiter registered before `dispatchTurn` is called
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `pg-boss`'s `work`/`send` typings reject `localConcurrency`, `includeMetadata`, `singletonKey`, or `db` — the integration assumptions are wrong; do not shim around the types.
- The orchestrator's current code does not match the "Current state" excerpts (drift).
- You cannot express "Flue instance is live" via `listRunningSubmissions` + `sessionKeyForInstance` (e.g. the execution store is never registered in this app path) — the resume design needs rethinking, not improvising.
- Preserving the task-status machine forces a NEW task status value — the Discord header (`src/discord/task-header.ts`) and controls depend on the existing seven.
- More than 3 existing test files need assertion semantics (not mechanism) changed — that means behavior drifted, which this plan forbids.

## Maintenance notes

- A hung Flue turn now holds a worker slot indefinitely (heartbeat keeps the job alive). Flue's own guardrails (`AGENT_MAX_TOOL_FAILURES`, `AGENT_SUBMISSION_MAX_ATTEMPTS`) plus the operator `abort` command are the mitigations. If hangs are observed in practice, add a `TURN_TIMEOUT_MINUTES` deferred-rejection — explicitly deferred out of this plan.
- The completion bridge assumes at most one in-flight turn per `flueInstanceId`; `key_strict_fifo` on `singletonKey = taskId` is what guarantees it. Weakening the queue policy breaks the bridge.
- Reviewer focus: waiter-before-dispatch ordering (step 2.5 note), and that every settle path writes the turn row before the task row.
