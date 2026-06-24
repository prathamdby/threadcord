import { describe, expect, it } from "vitest";
import { prepareSessionEntry } from "@flue/runtime/adapter";
import type { Pool, PoolClient, QueryResult } from "pg";
import { createFluePostgres, createPostgresRunner } from "../src/db.js";

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

describe("createFluePostgres transaction query serialization", () => {
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

  it("serializes concurrent reads during session load", async () => {
    const sessionBody = {
      version: 7,
      affinityKey: "affinity-1",
      leafId: null,
      childSessions: [],
      metadata: {},
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
    };
    const entryRows = ["entry-a", "entry-b"].map((entryId) => ({
      entry_id: entryId,
      data: JSON.stringify(
        prepareSessionEntry({
          type: "message",
          id: entryId,
          parentId: null,
          timestamp: "2026-06-03T00:00:00.000Z",
          message: { role: "user", content: "hello", timestamp: 0 },
        }).value,
      ),
    }));

    const { pool, client } = createTrackingPool(async (text) => {
      if (text.includes("FROM flue_sessions")) {
        return {
          ...emptyResult(),
          rows: [{ data: JSON.stringify(sessionBody) }],
        };
      }
      if (text.includes("FROM flue_session_entries")) {
        return { ...emptyResult(), rows: entryRows };
      }
      if (text.includes("FROM flue_image_chunks")) {
        return emptyResult();
      }
      return emptyResult();
    });

    const adapter = createFluePostgres(pool);
    const { executionStore } = await adapter.connect();
    await executionStore.sessions.load("session-1");

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
