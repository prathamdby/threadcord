import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultMcpRegistry,
  McpRegistryConfigProvider,
  type McpRegistry,
} from "../src/mcp/registry.js";
import type { McpServerInput, McpServerRow, McpStore } from "../src/mcp/store.js";
import type { Pool } from "pg";

class FakeMcpStore {
  readonly pool: Pool = {} as Pool;
  readonly servers = new Map<string, McpServerRow>();
  failAdd = false;
  failRemove = false;

  async migrate(): Promise<void> {}

  async listServers(): Promise<McpServerRow[]> {
    return [...this.servers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getServer(id: string): Promise<McpServerRow | undefined> {
    return this.servers.get(id);
  }

  async addServer(input: McpServerInput): Promise<McpServerRow> {
    if (this.failAdd) {
      throw new Error(`DB add failed for ${input.id}`);
    }
    if (this.servers.has(input.id)) {
      throw new Error(`Duplicate MCP server id "${input.id}"`);
    }
    const row: McpServerRow = {
      ...input,
      createdAt: new Date(),
    };
    this.servers.set(input.id, row);
    return row;
  }

  async removeServer(id: string): Promise<boolean> {
    if (this.failRemove) {
      throw new Error(`DB remove failed for ${id}`);
    }
    return this.servers.delete(id);
  }
}

function makeRegistry(): {
  registry: McpRegistry;
  store: FakeMcpStore;
} {
  const rawStore = new FakeMcpStore();
  const registry = new DefaultMcpRegistry({
    store: rawStore as unknown as McpStore,
  });
  return { registry, store: rawStore };
}

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "mcp-registry-"));
}

function cleanWorkspace(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

async function readConfigFile(workspace: string): Promise<unknown> {
  const content = await readFile(join(workspace, ".mcp.json"), "utf8");
  return JSON.parse(content);
}

describe("McpRegistry snapshot", () => {
  it("returns a sanitized snapshot without raw token fields", async () => {
    const { registry, store } = makeRegistry();
    await store.addServer({
      id: "server-a",
      url: "https://a.example.com",
      transport: "sse",
      headers: { "X-Tenant": "acme" },
      token: "secret-token",
    });

    const snapshot = await registry.snapshot();

    expect(snapshot).toEqual([
      {
        id: "server-a",
        url: "https://a.example.com",
        transport: "sse",
        headers: { "X-Tenant": "acme" },
      },
    ]);
    expect(snapshot[0]).not.toHaveProperty("token");
  });

  it("lists servers ordered by id", async () => {
    const { registry, store } = makeRegistry();
    await store.addServer({ id: "server-b", url: "https://b.example.com" });
    await store.addServer({ id: "server-a", url: "https://a.example.com" });

    const snapshot = await registry.snapshot();

    expect(snapshot.map((s) => s.id)).toEqual(["server-a", "server-b"]);
  });
});

describe("McpRegistry materializeConfig", () => {
  it("writes a parseable .mcp.json for coding turns", async () => {
    const { registry, store } = makeRegistry();
    await store.addServer({
      id: "server-a",
      url: "https://a.example.com",
      transport: "sse",
      token: "tok",
    });
    const workspace = tempWorkspace();

    const servers = await registry.materializeConfig(workspace, "coding");

    expect(servers).toEqual([
      { type: "remote", url: "https://a.example.com", headers: { Authorization: "Bearer tok" } },
    ]);
    const parsed = await readConfigFile(workspace);
    expect(parsed).toEqual({
      mcpServers: [
        { id: "server-a", type: "remote", url: "https://a.example.com", headers: { Authorization: "Bearer tok" } },
      ],
    });
    cleanWorkspace(workspace);
  });

  it("writes an empty config for setup turns", async () => {
    const { registry, store } = makeRegistry();
    await store.addServer({ id: "server-a", url: "https://a.example.com" });
    const workspace = tempWorkspace();

    const servers = await registry.materializeConfig(workspace, "setup");

    expect(servers).toEqual([]);
    const parsed = await readConfigFile(workspace);
    expect(parsed).toEqual({ mcpServers: [] });
    cleanWorkspace(workspace);
  });

  it("converts streamable-http transport to a remote AgentOS config", async () => {
    const { registry, store } = makeRegistry();
    await store.addServer({ id: "server-a", url: "https://a.example.com", transport: "streamable-http" });
    const workspace = tempWorkspace();

    const servers = await registry.materializeConfig(workspace, "coding");

    expect(servers[0]).toMatchObject({ type: "remote", url: "https://a.example.com" });
    cleanWorkspace(workspace);
  });
});

describe("McpRegistry lifecycle", () => {
  it("reports zero tools when AgentOS manages the connection pool", async () => {
    const { registry } = makeRegistry();

    const tools = await registry.tools();

    expect(tools).toEqual([]);
  });

  it("addServer persists the server and reports zero tool count", async () => {
    const { registry, store } = makeRegistry();

    const result = await registry.addServer({
      id: "server-a",
      url: "https://a.example.com",
      transport: "sse",
    });

    expect(result.toolCount).toBe(0);
    expect(store.servers.has("server-a")).toBe(true);
  });

  it("addServer rolls back when persistence fails", async () => {
    const { registry, store } = makeRegistry();
    store.failAdd = true;

    await expect(
      registry.addServer({ id: "server-a", url: "https://a.example.com" }),
    ).rejects.toThrow("DB add failed for server-a");

    expect(store.servers.has("server-a")).toBe(false);
  });

  it("removeServer deletes the persisted row", async () => {
    const { registry, store } = makeRegistry();
    await store.addServer({ id: "server-a", url: "https://a.example.com" });

    const removed = await registry.removeServer("server-a");

    expect(removed).toBe(true);
    expect(store.servers.has("server-a")).toBe(false);
  });
});

describe("McpRegistryConfigProvider", () => {
  it("materializes the config before parsing it", async () => {
    const { registry, store } = makeRegistry();
    await store.addServer({ id: "server-a", url: "https://a.example.com" });
    const workspace = tempWorkspace();
    const provider = new McpRegistryConfigProvider(registry);
    provider.setWorkspacePath(workspace);

    const parsed = await provider.parse();

    expect(parsed).toEqual({ mcpServers: [{ id: "server-a", type: "remote", url: "https://a.example.com" }] });
    cleanWorkspace(workspace);
  });
});
