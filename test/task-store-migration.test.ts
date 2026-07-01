import { describe, expect, it } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import { TaskStore } from "../src/task/store.js";

type QueryHandler = (
  text: string,
  params?: unknown[],
) => Promise<QueryResult<Record<string, unknown>>>;

function createTrackingPool(handler: QueryHandler): {
  pool: Pool;
  commands: string[];
} {
  const commands: string[] = [];
  const client = {
    async query(text: string, params?: unknown[]) {
      commands.push(text);
      return handler(text, params);
    },
    release() {},
  };
  const pool = {
    query: client.query.bind(client),
    connect: async () => client as unknown as PoolClient,
    end: async () => {},
  } as unknown as Pool;
  return { pool, commands };
}

function emptyResult(): QueryResult<Record<string, unknown>> {
  return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
}

function isFlueColumnCheck(text: string): boolean {
  return (
    text.includes("information_schema.columns") &&
    text.includes("flue_instance_id")
  );
}

function isFlueBackfill(text: string): boolean {
  return (
    text.includes("UPDATE tasks") && text.includes("flue_instance_id")
  );
}

describe("TaskStore migration", () => {
  it("runs cleanly on a fresh DB without flue_instance_id", async () => {
    const { pool, commands } = createTrackingPool(async (text) => {
      if (isFlueColumnCheck(text)) {
        return { ...emptyResult(), rows: [] };
      }
      return emptyResult();
    });
    const store = new TaskStore(pool, 1);

    await expect(store.migrate()).resolves.toBeUndefined();

    expect(commands.some(isFlueBackfill)).toBe(false);
    expect(
      commands.some((c) => c.includes("DROP COLUMN IF EXISTS flue_instance_id")),
    ).toBe(true);
  });

  it("backfills agent_instance_id when flue_instance_id is present", async () => {
    const { pool, commands } = createTrackingPool(async (text) => {
      if (isFlueColumnCheck(text)) {
        return { ...emptyResult(), rows: [{ "?column?": 1 }] };
      }
      return emptyResult();
    });
    const store = new TaskStore(pool, 1);

    await expect(store.migrate()).resolves.toBeUndefined();

    expect(commands.some(isFlueBackfill)).toBe(true);
  });
});
