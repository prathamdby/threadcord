import { describe, expect, it } from "vitest";
import { McpPool } from "../src/flue/mcp.js";

describe("McpPool", () => {
  it("returns empty tools when no servers are configured", async () => {
    const pool = new McpPool();
    const tools = await pool.tools();
    expect(tools).toEqual([]);
  });

  it("close resets the pool for reconnection", async () => {
    const pool = new McpPool();
    await pool.ready();
    await pool.close();
    // After close, tools() re-runs ready and returns empty
    const tools = await pool.tools();
    expect(tools).toEqual([]);
  });
});
