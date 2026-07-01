import { describe, expect, it } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import { createPostgresRunner } from "../src/db.js";

type QueryHandler = (
  text: string,
  params?: unknown[],
) => Promise<QueryResult<Record<string, unknown>>>;

function createTrackingPool(handler: QueryHandler): {
  pool: Pool;
  client: {
    maxActive: number;
    releaseCount: number;
    commands: string[];
  };
} {
  const client = {
    active: 0,
    maxActive: 0,
    releaseCount: 0,
    commands: [] as string[],
    async query(text: string, params?: unknown[]) {
      client.commands.push(text.trim().split(/\s+/)[0] ?? text);
      client.active += 1;
      client.maxActive = Math.max(client.maxActive, client.active);
      try {
        return await handler(text, params);
      } finally {
        client.active -= 1;
      }
    },
    release() {
      client.releaseCount += 1;
    },
  };

  const pool = {
    query: client.query.bind(client),
    connect: async () => client as unknown as PoolClient,
    end: async () => {},
  } as unknown as Pool;

  return {
    pool,
    client: {
      get maxActive() {
        return client.maxActive;
      },
      get releaseCount() {
        return client.releaseCount;
      },
      get commands() {
        return client.commands;
      },
    },
  };
}

function emptyResult(): QueryResult<Record<string, unknown>> {
  return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
}

describe("createPostgresRunner transaction query serialization", () => {
  it("serializes concurrent tx.query calls", async () => {
    let inFlight = 0;
    const { pool, client } = createTrackingPool(async () => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return emptyResult();
    });

    const runner = createPostgresRunner(pool);
    await runner.transaction(async (tx) => {
      await Promise.all([
        tx.query("SELECT 1"),
        tx.query("SELECT 2"),
        tx.query("SELECT 3"),
      ]);
    });

    expect(client.maxActive).toBe(1);
  });

  it("rolls back and releases the client when a transaction query fails", async () => {
    const { pool, client } = createTrackingPool(async (text) => {
      if (text === "BEGIN" || text === "ROLLBACK") return emptyResult();
      throw new Error("query failed");
    });

    const runner = createPostgresRunner(pool);
    await expect(
      runner.transaction(async (tx) => {
        await tx.query("SELECT boom");
      }),
    ).rejects.toThrow("query failed");

    expect(client.commands).toContain("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });
});
