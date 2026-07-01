import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  McpRegistry,
  McpServerSnapshot,
} from "../../src/mcp/registry.js";
import type { McpServerInput, McpServerRow } from "../../src/mcp/store.js";
import type { AgentTurnRole } from "../../src/agentturn/types.js";
import { toAcpMcpServer, type AcpMcpServerConfig } from "../../src/mcp/acp-config.js";

interface McpServerConnection {
  name: string;
  tools: { name: string; description?: string; inputSchema?: unknown }[];
  close(): Promise<void>;
}

export class FakeMcpRegistry implements McpRegistry {
  readonly servers = new Map<string, McpServerRow>();
  readonly snapshotCalls: number[] = [];
  readonly materializeConfigCalls: {
    workspacePath: string;
    role: AgentTurnRole | undefined;
  }[] = [];
  readonly addServerCalls: McpServerInput[] = [];
  readonly removeServerCalls: string[] = [];
  closed = false;
  warmed = false;
  failAddServer = false;
  failRemoveServer = false;
  failPersist = false;
  failMaterialize = false;

  async snapshot(): Promise<McpServerSnapshot[]> {
    this.snapshotCalls.push(Date.now());
    return [...this.servers.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        url: row.url,
        ...(row.transport ? { transport: row.transport } : {}),
        ...(row.headers ? { headers: row.headers } : {}),
      }));
  }

  getConfigPath(workspacePath: string): string {
    return join(workspacePath, ".mcp.json");
  }

  async materializeConfig(
    workspacePath: string,
    role?: AgentTurnRole,
  ): Promise<AcpMcpServerConfig[]> {
    this.materializeConfigCalls.push({ workspacePath, role });
    if (this.failMaterialize) {
      throw new Error("MCP materialize failed");
    }
    await mkdir(workspacePath, { recursive: true });
    const rows = [...this.servers.values()].sort((a, b) => a.id.localeCompare(b.id));
    const servers: Array<AcpMcpServerConfig & { id: string }> =
      role === "setup"
        ? []
        : rows.map((row) => ({
            id: row.id,
            ...toAcpMcpServer(row),
          }));
    await writeFile(
      this.getConfigPath(workspacePath),
      JSON.stringify({ mcpServers: servers }, null, 2),
    );
    return servers.map(({ id, ...config }) => config);
  }

  async warm(): Promise<void> {
    this.warmed = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async addServer(
    input: McpServerInput,
  ): Promise<{ connection: McpServerConnection; toolCount: number }> {
    this.addServerCalls.push(input);
    if (this.failAddServer) {
      throw new Error(`Failed to connect to MCP server ${input.id}`);
    }
    if (this.failPersist) {
      throw new Error(`Failed to persist MCP server ${input.id}`);
    }
    this.servers.set(input.id, {
      ...input,
      createdAt: new Date(),
    });
    return {
      connection: { name: input.id, tools: [], close: async () => {} },
      toolCount: 0,
    };
  }

  async removeServer(id: string): Promise<boolean> {
    this.removeServerCalls.push(id);
    if (this.failRemoveServer) {
      throw new Error(`Failed to remove MCP server ${id}`);
    }
    return this.servers.delete(id);
  }

  async tools(): Promise<never[]> {
    return [];
  }

  async addServerFromCommand(
    id: string,
    url: string,
    transport: string,
    token?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    const input: McpServerInput = {
      id,
      url,
      ...(transport ? { transport } : {}),
      ...(token ? { token } : {}),
      ...(headers ? { headers } : {}),
    };
    await this.addServer(input);
  }

  async readConfig(workspacePath: string): Promise<unknown> {
    const content = await readFile(this.getConfigPath(workspacePath), "utf8");
    return JSON.parse(content);
  }
}
