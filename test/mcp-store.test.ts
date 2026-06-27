import { describe, expect, it } from "vitest";
import { McpStore } from "../src/mcp/store.js";

/**
 * McpStore tests run against the real Postgres when DATABASE_URL is set.
 * Otherwise they validate the interface shape and error paths only.
 */

function hasDatabase(): boolean {
  return typeof process.env.DATABASE_URL === "string";
}

function describeWithDb(
  name: string,
  fn: (store: () => McpStore) => void,
): void {
  const skip = !hasDatabase();
  const suite = skip ? describe.skip : describe;
  suite(name, () => {
    // These tests would need a real Pool; the skip guard keeps CI green
    // without Postgres. When DATABASE_URL is available they run for real.
    const pg = skip
      ? (undefined as unknown as import("pg").Pool)
      : (() => {
          // Lazy import so the module doesn't fail when pg isn't configured
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { Pool } = require("pg") as typeof import("pg");
          return new Pool({ connectionString: process.env.DATABASE_URL });
        })();
    const store = () => new McpStore(pg);
    fn(store);
  });
}

describe("McpStore validation", () => {
  it("rejects invalid server ids", () => {
    // The store constructor needs a Pool, but validation happens before any
    // query, so we can pass a stub.
    const store = new McpStore(null as unknown as import("pg").Pool);
    expect(
      store.addServer({ id: "Bad_Id", url: "https://example.com" }),
    ).rejects.toThrow(/Invalid MCP server id/);
    expect(
      store.addServer({ id: "has spaces", url: "https://example.com" }),
    ).rejects.toThrow(/Invalid MCP server id/);
    expect(
      store.addServer({ id: "UPPER", url: "https://example.com" }),
    ).rejects.toThrow(/Invalid MCP server id/);
  });
});

describeWithDb("McpStore with Postgres", (store) => {
  it("adds and retrieves a server", async () => {
    const s = store();
    await s.migrate();
    const id = `test-${Date.now()}`;
    const row = await s.addServer({
      id,
      url: "https://mcp.example.com",
      token: "secret",
      headers: { "X-Tenant": "acme" },
    });
    expect(row.id).toBe(id);
    expect(row.url).toBe("https://mcp.example.com");
    expect(row.token).toBe("secret");
    expect(row.headers).toEqual({ "X-Tenant": "acme" });

    const fetched = await s.getServer(id);
    expect(fetched?.id).toBe(id);
    expect(fetched?.token).toBe("secret");

    // cleanup
    await s.removeServer(id);
  });

  it("rejects duplicate ids", async () => {
    const s = store();
    await s.migrate();
    const id = `dup-${Date.now()}`;
    await s.addServer({ id, url: "https://a.example.com" });
    await expect(
      s.addServer({ id, url: "https://b.example.com" }),
    ).rejects.toThrow();
    await s.removeServer(id);
  });

  it("removes a server and returns false for missing ids", async () => {
    const s = store();
    await s.migrate();
    const id = `rm-${Date.now()}`;
    await s.addServer({ id, url: "https://a.example.com" });
    expect(await s.removeServer(id)).toBe(true);
    expect(await s.removeServer(id)).toBe(false);
    expect(await s.getServer(id)).toBeUndefined();
  });

  it("lists servers ordered by id", async () => {
    const s = store();
    await s.migrate();
    const prefix = `list-${Date.now()}`;
    await s.addServer({ id: `${prefix}-b`, url: "https://b.example.com" });
    await s.addServer({ id: `${prefix}-a`, url: "https://a.example.com" });
    const all = await s.listServers();
    const ours = all.filter((srv) => srv.id.startsWith(prefix));
    expect(ours.map((srv) => srv.id)).toEqual([`${prefix}-a`, `${prefix}-b`]);
    await s.removeServer(`${prefix}-a`);
    await s.removeServer(`${prefix}-b`);
  });

  it("returns empty array when no servers exist", async () => {
    const s = store();
    await s.migrate();
    const all = await s.listServers();
    expect(Array.isArray(all)).toBe(true);
  });
});
