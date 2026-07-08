# Plan 002: Create the durable `task_turns` work-item table and its repository

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6cba1de..HEAD -- src/task/store.ts src/types.ts`
> Exclude changes made by plan 001 (different files). If `src/task/store.ts`
> changed since `6cba1de`, compare the "Current state" excerpts against the
> live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (additive schema + new module; nothing reads `task_turns` yet)
- **Depends on**: none (can run in parallel with 001; both precede 003)
- **Category**: tech-debt (queue durability refactor, part 2 of 4)
- **Planned at**: commit `6cba1de`, 2026-07-08

## Why this matters

Today a queued turn exists in two shapes: the task row itself (initial turn, `tasks.status='queued'`) and a `task_followups` row (follow-up). Neither carries attempt counts, error history, or a cancellation gate, so retries and safe cancellation are impossible to express. This plan adds a single durable `task_turns` table (modeled on pr-agent's `agent_work_items`) plus a repository of race-safe mutations. It is purely additive: the legacy scheduler keeps running until plan 003 switches over.

## Current state

- `src/task/store.ts` — `TaskStore` class. `migrate()` (lines 18-115) is a sequence of idempotent `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` statements run via `this.pool.query`. Threadcord has NO `schema_migrations` table; this plan deliberately keeps that convention (single-process app; migrations are idempotent statements, not versioned files). `tasks.id` is `TEXT PRIMARY KEY` (line 21) populated with `randomUUID()` — do NOT change it to `uuid`.
- `src/task/store.ts:106-114` — the legacy follow-up table (stays in place until plan 004):
  ```sql
  CREATE TABLE IF NOT EXISTS task_followups (
    id BIGSERIAL PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    discord_message_id TEXT NOT NULL UNIQUE,
    instruction TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  ```
- `src/task/store.ts:354-372` — `transition()` shows the repo's race-guard idiom (guarded UPDATE, caller branches on the returned row/undefined). The new repository must follow the same idiom.
- `src/types.ts` — `TASK_STATUSES` and `TaskRecord` live here; add turn types next to them.
- Convention: `exactOptionalPropertyTypes` is on — optional fields are conditionally spread (see `rowToTask` in `src/task/store.ts:487-530`), never assigned `undefined`.

### Reference pattern (pr-agent, inline)

The claim/mutation SQL idiom (pr-agent `src/agentWork/repository.ts`; `(status='running' AND cancel_requested_at IS NULL)` is the "I still own this work" predicate):

```sql
-- one-query claim: returns the row, or nothing if not claimable
UPDATE agent_work_items
   SET status = 'running', started_at = COALESCE(started_at, now()),
       attempt_count = attempt_count + 1, updated_at = now()
 WHERE id = $1 AND status = 'queued' AND cancel_requested_at IS NULL
RETURNING *;

-- completion guarded by ownership; rowCount 0 = lost a race to cancel
UPDATE agent_work_items
   SET status = 'completed', completed_at = now(), updated_at = now()
 WHERE id = $1 AND status = 'running' AND cancel_requested_at IS NULL;
```

pr-agent's resume-aware claim (`claimWorkForExecution`) is a boolean: try the claim UPDATE; if 0 rows, re-read the row and return `true` iff `status='running' AND cancel_requested_at IS NULL`. This is what lets a pg-boss redelivery resume a still-running row WITHOUT double-bumping `attempt_count`.

## Commands you will need

| Purpose   | Command         | Expected on success |
|-----------|-----------------|---------------------|
| Typecheck | `npm run check` | exit 0 |
| Tests     | `npm test`      | exit 0, all pass (Postgres is mocked; no DB needed) |

## Scope

**In scope**:
- `src/types.ts` (add `TURN_STATUSES`, `TurnStatus`, `TaskTurnRecord`)
- `src/task/turn-store.ts` (create — the new repository)
- `src/task/store.ts` (ONLY: append `task_turns` DDL + backfill to `migrate()`)
- `test/turn-store.test.ts` (create)

**Out of scope**:
- Every other method of `TaskStore` — the legacy scheduler must keep working unchanged until plan 003.
- `src/task/orchestrator.ts`, `src/app.ts`, `src/setup/**`, `src/mcp/**`.
- Dropping `task_followups` or `initial_turn_started` — that is plan 004.

## Git workflow

- Branch: `pd/refactor/pgboss-queue` (continue from plan 001).
- One commit; suggested: `feat: add task_turns durable work-item table and repository`.
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Add turn types to `src/types.ts`

```ts
export const TURN_STATUSES = ["queued", "running", "cancelled", "completed", "failed"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];
export interface TaskTurnRecord {
  id: string;                       // uuid generated with crypto.randomUUID()
  taskId: string;
  source: "initial" | "followup";
  instruction: string;
  discordMessageId?: string;        // conditionally spread, exactOptionalPropertyTypes
  status: TurnStatus;
  attemptCount: number;
  cancelRequestedAt?: Date;
  lastError?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
}
```

**Verify**: `npm run check` → exit 0.

### Step 2: Append `task_turns` DDL to `TaskStore.migrate()`

Append AFTER the existing `task_followups` block (keep everything above untouched):

```sql
CREATE TABLE IF NOT EXISTS task_turns (
  id UUID PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('initial', 'followup')),
  instruction TEXT NOT NULL,
  discord_message_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cancelled', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_turns_task_status_idx ON task_turns(task_id, status);
CREATE INDEX IF NOT EXISTS task_turns_retention_idx ON task_turns(status, updated_at);
```

Run each statement as its own `this.pool.query`, matching the file's existing style. Do NOT add a data backfill here — plan 003 migrates pending `task_followups` rows at switchover time, when the writers change.

**Verify**: `npm test -- task-store-migrate` → existing migrate test still passes (it asserts a query-order prefix; appending is safe — if it asserts an exact total count and fails, update ONLY the expected count/list in that test).

### Step 3: Create `src/task/turn-store.ts`

`export class TurnStore { constructor(private readonly pool: Pool) {} }` with these methods (all SQL follows the reference idiom above; `client?: PoolClient` parameters let plan 003 ride intake transactions):

- `insertTurn(turn: { id, taskId, source, instruction, discordMessageId? }, client?)` → `Promise<{ created: boolean }>` — `INSERT ... ON CONFLICT (discord_message_id) DO NOTHING`; `created` = rowCount > 0. `status` starts `'queued'`.
- `claimQueuedTurn(turnId)` → `Promise<TaskTurnRecord | undefined>` — the one-query claim (UPDATE queued→running, bump `attempt_count`, `started_at = COALESCE(started_at, now())`, RETURNING *).
- `resumeTurnForExecution(turnId)` → `Promise<boolean>` — resume-aware claim: try `claimQueuedTurn`-style UPDATE (without RETURNING); if 0 rows, SELECT the row and return `status === 'running' && cancel_requested_at IS NULL`. Must NOT bump `attempt_count` on the resume path.
- `markTurnCompleted(turnId)` → `Promise<boolean>` — guarded by `status='running' AND cancel_requested_at IS NULL`.
- `markTurnFailed(turnId, lastError: string)` → `Promise<boolean>` — same guard; sets `last_error`, `completed_at`.
- `markTurnRetrying(turnId, lastError: string)` → `Promise<boolean>` — `running` → `queued`, sets `last_error`, same guard, does NOT touch `attempt_count` (the next claim bumps it).
- `requestCancel(turnId)` → `Promise<void>` — `SET cancel_requested_at = COALESCE(cancel_requested_at, now())` unconditionally (matches pr-agent: cancellation request is a gate, not a status).
- `markTurnCancelled(turnId)` → `Promise<void>` — `SET status='cancelled', completed_at = COALESCE(completed_at, now())` where `status IN ('queued','running')`; void return (cancellation is unconditional cleanup, unlike the boolean racers).
- `cancelPendingTurnsForTask(taskId, client?)` → `Promise<string[]>` — cancel every `queued` turn of a task, RETURNING ids (plan 004 uses the ids to cancel the matching pg-boss jobs).
- `shouldSkipTurn(turnId)` → `Promise<boolean>` — SELECT; true when the row is missing, terminal, or `cancel_requested_at` is set. This is the checkpoint predicate plan 003 calls between execution steps.
- `getTurn(turnId)` → `Promise<TaskTurnRecord | undefined>`.
- `deleteAgedTerminalTurns(retentionDays: number, batchSize: number)` → `Promise<number>` — `DELETE ... WHERE id IN (SELECT id FROM task_turns WHERE status IN ('completed','failed','cancelled') AND updated_at < now() - ($1::text || ' days')::interval LIMIT $2)`; returns rowCount (plan 004 loops it).

Include a private `rowToTurn` mapper following the conditional-spread style of `rowToTask` (`src/task/store.ts:487-530`).

**Verify**: `npm run check` → exit 0.

### Step 4: Unit tests

Create `test/turn-store.test.ts` with a mocked `Pool` (capture `(sql, values)` pairs; the repo's existing store tests, e.g. `test/task-store-migrate.test.ts`, show the mocking style). Cases:

1. `insertTurn` issues `ON CONFLICT (discord_message_id) DO NOTHING`; second insert with same message id reports `created: false`.
2. `claimQueuedTurn` SQL contains `status = 'queued' AND cancel_requested_at IS NULL` and `attempt_count = attempt_count + 1`, and returns undefined on empty rows.
3. `resumeTurnForExecution` returns true for a running non-cancelled row WITHOUT a second attempt bump (assert the fallback SELECT path issues no UPDATE).
4. `markTurnCompleted` / `markTurnFailed` / `markTurnRetrying` return false when rowCount is 0 (lost race).
5. `requestCancel` uses `COALESCE(cancel_requested_at, now())`.
6. `shouldSkipTurn` is true for: missing row, `status='cancelled'`, `cancel_requested_at` set.
7. `deleteAgedTerminalTurns` limits by batch size and filters to terminal statuses.

**Verify**: `npm test -- turn-store` → all 7+ cases pass.

## Test plan

Covered by Step 4. Existing tests must stay green untouched (except the possible expected-count fix in `task-store-migrate` noted in Step 2).

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0; `test/turn-store.test.ts` exists and covers the 7 cases
- [ ] `grep -n "task_turns" src/task/store.ts` shows the DDL in `migrate()`
- [ ] `grep -rn "task_turns" src/task/orchestrator.ts` returns no matches (nothing consumes it yet)
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `TaskStore.migrate()` no longer matches the "Current state" excerpt (drifted).
- The `task-store-migrate` test failure is anything other than an expected-count mismatch from the appended statements.
- You find an existing `task_turns` table definition anywhere (`grep -rn "task_turns" src/ test/`) — the plan assumes it does not exist.

## Maintenance notes

- Plan 003 consumes every method here; keep signatures stable.
- `tasks.status` remains the user-facing state machine; `task_turns.status` is the work-item machine. They are reconciled by the turn executor (plan 003), never by triggers.
- Reviewer focus: every guarded UPDATE must include BOTH `status` and `cancel_requested_at` predicates; a missing gate reopens the cancel race this table exists to close.
