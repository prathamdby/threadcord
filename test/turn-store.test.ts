import { describe, expect, it } from "vitest";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { TurnStore } from "../src/task/turn-store.js";

interface CapturedCall {
  sql: string;
  values: unknown[];
  /** rowCount that the mock reported for this call. */
  rowCount: number;
}

type QueryHandler = (
  text: string,
  values?: unknown[],
) => QueryResult<QueryResultRow>;

/**
 * Mock `Pool` that records every `query(text, values)` call and delegates to
 * `handler` for the result. The handler decides what to return per SQL, which
 * lets each test script both the row data and the rowCount the repository
 * branches on.
 */
function createMockPool(handler: QueryHandler): {
  pool: Pool;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const pool = {
    async query(text: string, values?: unknown[]) {
      const result = await Promise.resolve(handler(text, values));
      calls.push({
        sql: text,
        values: values ?? [],
        rowCount: result.rowCount ?? 0,
      });
      return result;
    },
  } as unknown as Pool;
  return { pool, calls };
}

/** A minimal PoolClient mock sharing the pool's query recorder. */
function createMockClient(handler: QueryHandler): {
  client: PoolClient;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      const result = await Promise.resolve(handler(text, values));
      calls.push({
        sql: text,
        values: values ?? [],
        rowCount: result.rowCount ?? 0,
      });
      return result;
    },
    release() {},
  } as unknown as PoolClient;
  return { client, calls };
}

function result(
  rows: QueryResultRow[] = [],
  rowCount = rows.length,
): QueryResult<QueryResultRow> {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

function hasText(sql: string, needle: string): boolean {
  return sql.replace(/\s+/g, " ").includes(needle);
}

describe("TurnStore", () => {
  it("insertTurn issues ON CONFLICT (discord_message_id) DO NOTHING and reports created:false on conflict", async () => {
    let insertCount = 0;
    const { pool, calls } = createMockPool((text) => {
      if (hasText(text, "INSERT INTO task_turns")) {
        insertCount += 1;
        // First insert wins, second is skipped by the conflict rule.
        return result([], insertCount === 1 ? 1 : 0);
      }
      return result();
    });

    const store = new TurnStore(pool);
    const first = await store.insertTurn({
      id: "t1",
      taskId: "task-1",
      source: "initial",
      instruction: "do thing",
      discordMessageId: "msg-1",
    });
    const second = await store.insertTurn({
      id: "t1-dup",
      taskId: "task-1",
      source: "initial",
      instruction: "do thing",
      discordMessageId: "msg-1",
    });

    const inserts = calls.filter((c) => hasText(c.sql, "INSERT INTO task_turns"));
    expect(inserts).toHaveLength(2);
    expect(hasText(inserts[0]!.sql, "ON CONFLICT (discord_message_id) DO NOTHING")).toBe(true);
    expect(first).toEqual({ created: true });
    expect(second).toEqual({ created: false });
  });

  it("insertTurn routes through the provided client when given", async () => {
    const { client, calls } = createMockClient(() => result([], 1));
    const { pool, calls: poolCalls } = createMockPool(() => result([], 1));

    const store = new TurnStore(pool);
    await store.insertTurn(
      {
        id: "t1",
        taskId: "task-1",
        source: "followup",
        instruction: "again",
        discordMessageId: "msg-1",
      },
      client,
    );

    expect(calls).toHaveLength(1);
    expect(hasText(calls[0]!.sql, "INSERT INTO task_turns")).toBe(true);
    expect(poolCalls).toHaveLength(0);
  });

  it("claimQueuedTurn uses the queued + no-cancel guard, bumps attempt_count, and returns undefined on empty rows", async () => {
    const { pool, calls } = createMockPool((text) => {
      if (hasText(text, "UPDATE task_turns") && hasText(text, "RETURNING *")) {
        return result(); // nothing claimable
      }
      return result();
    });

    const store = new TurnStore(pool);
    const claimed = await store.claimQueuedTurn("t1");

    const update = calls.find(
      (c) => hasText(c.sql, "UPDATE task_turns") && hasText(c.sql, "RETURNING *"),
    );
    expect(update).toBeDefined();
    expect(hasText(update!.sql, "status = 'queued' AND cancel_requested_at IS NULL")).toBe(true);
    expect(hasText(update!.sql, "attempt_count = attempt_count + 1")).toBe(true);
    expect(claimed).toBeUndefined();
  });

  it("resumeTurnForExecution returns true for a running non-cancelled row without a second attempt bump", async () => {
    // The claim UPDATE matches 0 rows (row is already 'running'); the fallback
    // SELECT then reads a running, non-cancelled row.
    const { pool, calls } = createMockPool((text) => {
      if (hasText(text, "UPDATE task_turns") && hasText(text, "attempt_count = attempt_count + 1")) {
        return result([], 0); // claim misses: not queued
      }
      if (hasText(text, "SELECT status, cancel_requested_at")) {
        return result([{ status: "running", cancel_requested_at: null }]);
      }
      return result();
    });

    const store = new TurnStore(pool);
    const ok = await store.resumeTurnForExecution("t1");

    expect(ok).toBe(true);
    const updates = calls.filter((c) => hasText(c.sql, "UPDATE task_turns"));
    // Exactly one UPDATE: the claim attempt. The fallback SELECT path issues no
    // UPDATE, so attempt_count is never bumped a second time.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.rowCount).toBe(0);
    const selects = calls.filter((c) => hasText(c.sql, "SELECT status, cancel_requested_at"));
    expect(selects).toHaveLength(1);
  });

  it("markTurnCompleted / markTurnFailed / markTurnRetrying return false on a lost race (rowCount 0)", async () => {
    const { pool } = createMockPool(() => result([], 0));
    const store = new TurnStore(pool);

    expect(await store.markTurnCompleted("t1")).toBe(false);
    expect(await store.markTurnFailed("t1", "boom")).toBe(false);
    expect(await store.markTurnRetrying("t1", "transient")).toBe(false);
  });

  it("requestCancel uses COALESCE(cancel_requested_at, now())", async () => {
    const { pool, calls } = createMockPool(() => result([], 1));
    const store = new TurnStore(pool);
    await store.requestCancel("t1");

    const update = calls.find((c) => hasText(c.sql, "UPDATE task_turns"));
    expect(update).toBeDefined();
    expect(hasText(update!.sql, "cancel_requested_at = COALESCE(cancel_requested_at, now())")).toBe(true);
  });

  it("shouldSkipTurn is true for a missing row, a cancelled row, and a cancel-requested row", async () => {
    const missing = createMockPool(() => result([], 0));
    const cancelled = createMockPool(() =>
      result([{ status: "cancelled", cancel_requested_at: null }]),
    );
    const cancelRequested = createMockPool(() =>
      result([{ status: "running", cancel_requested_at: "2026-07-08T00:00:00Z" }]),
    );
    const healthy = createMockPool(() =>
      result([{ status: "running", cancel_requested_at: null }]),
    );

    expect(await new TurnStore(missing.pool).shouldSkipTurn("t1")).toBe(true);
    expect(await new TurnStore(cancelled.pool).shouldSkipTurn("t1")).toBe(true);
    expect(await new TurnStore(cancelRequested.pool).shouldSkipTurn("t1")).toBe(true);
    expect(await new TurnStore(healthy.pool).shouldSkipTurn("t1")).toBe(false);
  });

  it("deleteAgedTerminalTurns limits by batch size, filters to terminal statuses, and returns rowCount", async () => {
    const { pool, calls } = createMockPool(() => result([], 7));
    const store = new TurnStore(pool);
    const deleted = await store.deleteAgedTerminalTurns(14, 500);

    const del = calls.find((c) => hasText(c.sql, "DELETE FROM task_turns"));
    expect(del).toBeDefined();
    expect(hasText(del!.sql, "LIMIT $2")).toBe(true);
    expect(hasText(del!.sql, "status IN ('completed', 'failed', 'cancelled')")).toBe(true);
    expect(del!.values).toEqual(["14", 500]);
    expect(deleted).toBe(7);
  });
});
