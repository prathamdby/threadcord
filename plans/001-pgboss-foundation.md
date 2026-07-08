# Plan 001: Add pg-boss as the queue backbone (foundation only, no behavior change)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 6cba1de..HEAD -- src/db.ts src/config.ts src/app.ts package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (purely additive; nothing consumes the new queue yet)
- **Depends on**: none
- **Category**: tech-debt (queue durability refactor, part 1 of 4)
- **Planned at**: commit `6cba1de`, 2026-07-08

## Why this matters

Threadcord schedules agent turns with a hand-rolled Postgres scheduler: every claim serializes behind a single `pg_advisory_xact_lock(8675309)` (`src/task/store.ts:10,292-294`), there are no retries (any transient git/network error during a turn permanently fails the task via the catch block in `src/task/orchestrator.ts:745-763`), and no heartbeats or dead-lettering. This plan series ports the queuing architecture of the maintainer's pr-agent project (pg-boss + a durable work-item table). Plan 001 installs pg-boss, creates the queues, and wires lifecycle — with zero behavior change, so it can ship independently and safely.

## Current state

- `src/db.ts` — `pg` Pool singleton behind `initializeDatabase(url)` / `getPool()`; exports a `pool` Proxy. No transaction helper exists here.
- `src/config.ts` — Zod `EnvSchema` (starts line 22) with knobs like `MAX_CONCURRENT_TASKS: z.coerce.number().int().positive().default(3)`. New env vars follow this exact pattern.
- `src/app.ts:26-38` — `createApp()` loads config, `initializeDatabase`, then:
  ```ts
  await Promise.all([
    store.migrate(),
    setupStore.migrate(),
    mcpStore.migrate(),
  ]);
  ```
- `src/app.ts:133-140` — shutdown closure:
  ```ts
  shutdown: async () => {
    clearInterval(janitor);
    await closeMcpPool();
    await pool.end();
  },
  ```
- `package.json` — deps include `pg`, `zod`, `discord.js`, `hono`, `@flue/runtime`. `pg-boss` is NOT installed. Scripts: `check` (tsc --noEmit), `test` (vitest run), `build` (flue build).

### Reference pattern (pr-agent, inline — do not fetch anything)

pg-boss client-side DB adapter and transaction helper (pr-agent `src/db/postgres.ts`):

```ts
import type { Db } from "pg-boss";
export function pgBossDb(client: PoolClient): Db {
  return {
    executeSql: async (text: string, values?: unknown[]) => client.query(text, values),
  };
}
export async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
```

Boss construction and queue creation (pr-agent `src/agentWork/boss.ts`):

```ts
const boss = new PgBoss({ connectionString, application_name: "pr-agent", schedule: true, supervise: true });
boss.on("error", (e) => ...); boss.on("warning", (w) => ...);
await boss.start();
await boss.createQueue(DEAD, { retryLimit: 0, retryDelay: 0, retryBackoff: false, deleteAfterSeconds, retentionSeconds });
await boss.createQueue(MAIN, { retryLimit, retryDelay, retryBackoff: true, retryDelayMax, expireInSeconds, heartbeatSeconds, retentionSeconds, deleteAfterSeconds, policy: "key_strict_fifo", deadLetter: DEAD });
await boss.stop({ close: true, graceful: true, timeout: drainTimeoutMs });
```

## Commands you will need

| Purpose   | Command         | Expected on success |
|-----------|-----------------|---------------------|
| Install   | `npm install`   | exit 0 (engine warning on Node <22.18 is OK for install) |
| Typecheck | `npm run check` | exit 0, no output |
| Tests     | `npm test`      | exit 0, all pass |
| Build     | `npm run build` | exit 0 (requires Node >=22.18; see AGENTS.md) |

## Scope

**In scope** (the only files you should modify):
- `package.json`, `package-lock.json` (add `pg-boss`)
- `src/db.ts` (add `pgBossDb`, `inTransaction`)
- `src/config.ts` (add queue env vars)
- `src/task/boss.ts` (create)
- `src/app.ts` (boss lifecycle wiring)
- `test/task-boss.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/task/store.ts`, `src/task/orchestrator.ts` — the scheduler switchover happens in plans 002-004.
- `src/setup/**`, `src/mcp/**` — separate subsystems with their own stores.
- Any existing test file.

## Git workflow

- Branch: `pd/refactor/pgboss-queue` from `main` (create if absent; plans 002-004 continue on it).
- One commit for this plan; message style is conventional commits per repo history (`git log --oneline -5` shows `feat:` / `fix:`). Suggested: `feat: add pg-boss foundation for durable task queue`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Install pg-boss

`npm install pg-boss@^12`

**Verify**: `node -e "console.log(require('./node_modules/pg-boss/package.json').version)"` → prints a `12.x` version.

### Step 2: Add `pgBossDb` and `inTransaction` to `src/db.ts`

Copy the reference pattern above verbatim (adjust imports: `import type { Db } from "pg-boss";` and `PoolClient` from `pg`). Export both.

**Verify**: `npm run check` → exit 0.

### Step 3: Add queue config knobs to `src/config.ts`

Inside `EnvSchema`, following the exact `z.coerce.number().int().positive().default(...)` pattern used by `MAX_CONCURRENT_TASKS`:

- `QUEUE_RETRY_LIMIT` default `3`
- `QUEUE_RETRY_DELAY_SECONDS` default `30`
- `QUEUE_RETRY_DELAY_MAX_SECONDS` default `300`
- `QUEUE_EXPIRE_IN_SECONDS` default `7200` (2h; must exceed the 30-minute setup-install timeout in `src/task/bootstrap.ts`)
- `QUEUE_HEARTBEAT_SECONDS` default `60`
- `TURN_RETENTION_DAYS` default `14` (days, deliberately matching the existing `WORKSPACE_TTL_DAYS` day-unit convention rather than pr-agent's seconds)

**Verify**: `npm run check` → exit 0. `npm test` → all pass (config tests use defaults).

### Step 4: Create `src/task/boss.ts`

Exports:

- `TASK_TURN_QUEUE = "task-turn"` and `TASK_TURN_DEAD_LETTER_QUEUE = "task-turn-dead"`.
- `createStartedBoss(config: AppConfig): Promise<PgBoss>` — constructor options `{ connectionString: config.DATABASE_URL, application_name: "threadcord", schedule: true, supervise: true }`. Threadcord is single-process, so maintenance flags are unconditionally on (no role split; do not add role-detection code). Attach `error`/`warning` listeners that `console.error`/`console.warn` with a `[threadcord]` prefix (matching the logging style in `src/task/orchestrator.ts`). Then `await boss.start()`.
- `ensureTaskQueues(boss, config): Promise<void>` — create the DLQ first (`retryLimit: 0, retryDelay: 0, retryBackoff: false`), then `TASK_TURN_QUEUE` with `policy: "key_strict_fifo"`, `deadLetter: TASK_TURN_DEAD_LETTER_QUEUE`, and the retry/expire/heartbeat defaults from the Step 3 config values (`retentionSeconds`/`deleteAfterSeconds` from `TURN_RETENTION_DAYS * 86400`). `key_strict_fifo` = at most one active job per `singletonKey`, FIFO within the key; the singleton key will be the task id (plan 003).
- `stopBoss(boss, drainTimeoutMs = 25_000)` — `boss.stop({ close: true, graceful: true, timeout: drainTimeoutMs })`.

**Verify**: `npm run check` → exit 0.

### Step 5: Wire lifecycle in `src/app.ts`

After the `Promise.all([...migrate()])` call: `const boss = await createStartedBoss(config); await ensureTaskQueues(boss, config);`. Add `await stopBoss(boss);` to the shutdown closure BEFORE `await pool.end()`. Pass nothing to the orchestrator yet (plan 003 does that).

**Verify**: `npm run check` → exit 0. `npm test` → all pass (app.ts is not imported by unit tests; they mock at module level).

### Step 6: Unit test the boss module

Create `test/task-boss.test.ts`, modeled structurally on `test/task-store-migrate.test.ts` (mock-at-boundary style). Mock `pg-boss` (vitest `vi.mock`) and assert:

1. `createStartedBoss` constructs PgBoss with `application_name: "threadcord"`, `schedule: true`, `supervise: true`, and calls `start()`.
2. `ensureTaskQueues` creates the DLQ with `retryLimit: 0` and the main queue with `policy: "key_strict_fifo"` and `deadLetter: "task-turn-dead"`.
3. `stopBoss` calls `stop` with `{ close: true, graceful: true, timeout: 25000 }`.

**Verify**: `npm test -- task-boss` → new tests pass.

## Test plan

Covered by Step 6 (3 new tests in `test/task-boss.test.ts`). No existing tests change.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0; `test/task-boss.test.ts` exists with the 3 cases above
- [ ] `npm run build` exits 0 (on Node >=22.18)
- [ ] `grep -n "pg-boss" package.json` shows the dependency
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pg-boss@^12` is not installable or its `PgBoss` constructor/`createQueue` API does not accept the options named in Step 4 (check `node_modules/pg-boss` typings; the option names here were verified against pg-boss 12.22).
- `npm run build` fails with a Flue/Node version error you cannot resolve by using Node >=22.18 (see AGENTS.md).
- Adding `boss.start()` to `createApp()` makes `npm test` fail (would mean tests import `app.ts` — they should not; report instead of mocking around it).

## Maintenance notes

- Plans 002-004 build directly on these exports; renaming them breaks those plans.
- If threadcord ever splits web/worker roles, `schedule`/`supervise` must become role-conditional (see pr-agent's `bossConstructorOptions`).
- Reviewer focus: shutdown ordering (boss stops before the pool ends, or boss maintenance queries hit a closed pool).
