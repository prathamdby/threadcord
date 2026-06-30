import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig as AgentOsMcpServerConfig } from "@rivet-dev/agentos-core";
export type { McpServerConfig as AgentOsMcpServerConfig } from "@rivet-dev/agentos-core";
import type {
  McpServerConnection,
  McpTransport,
  ToolDefinition,
} from "@flue/runtime";
import type { McpConfigProvider } from "../agentturn/machine-environment.js";
import type { AgentTurnRole } from "../agentturn/types.js";
import { McpPool, type McpServerConfig as FlueMcpServerConfig } from "../flue/mcp.js";
import type { McpServerInput, McpServerRow, McpStore } from "./store.js";
import { buildHeaders } from "./validation.js";

export interface Logger {
  log(level: string, message: string, meta?: Record<string, unknown>): void;
}

export interface McpServerSnapshot {
  id: string;
  url: string;
  transport?: string;
  headers?: Record<string, string>;
}

export interface McpPoolLike {
  ready(): Promise<void>;
  tools(): Promise<ToolDefinition[]>;
  addServer(config: FlueMcpServerConfig): Promise<McpServerConnection>;
  removeServer(id: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface McpRegistry {
  /** Sanitized snapshot of registered servers (no raw token fields). */
  snapshot(): Promise<McpServerSnapshot[]>;
  /** Returns the path where the agent-specific MCP config is written. */
  getConfigPath(workspacePath: string): string;
  /** Writes the agent-specific `.mcp.json` config and returns the servers for AgentOS createSession. */
  materializeConfig(
    workspacePath: string,
    role?: AgentTurnRole,
  ): Promise<AgentOsMcpServerConfig[]>;
  /** Load persisted servers into the live connection pool. */
  warm(): Promise<void>;
  /** Close the live connection pool. */
  close(): Promise<void>;
  /** Validate, connect, and persist a new server. */
  addServer(
    input: McpServerInput,
  ): Promise<{ connection: McpServerConnection; toolCount: number }>;
  /** Close the pool connection and delete the server row. */
  removeServer(id: string): Promise<boolean>;
  /** Pooled MCP tools (Flue-shaped) for the transitional coding agent. */
  tools(): Promise<ToolDefinition[]>;
}

export interface McpRegistryDependencies {
  store: McpStore;
  pool?: McpPoolLike;
  logger?: Logger;
}

export class DefaultMcpRegistry implements McpRegistry {
  private readonly store: McpStore;
  private pool: McpPoolLike | undefined;
  private readonly logger: Logger;

  constructor(deps: McpRegistryDependencies) {
    this.store = deps.store;
    this.pool = deps.pool;
    this.logger = deps.logger ?? defaultLogger();
  }

  async snapshot(): Promise<McpServerSnapshot[]> {
    const rows = await this.store.listServers();
    return rows.map((row) => ({
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
  ): Promise<AgentOsMcpServerConfig[]> {
    await mkdir(workspacePath, { recursive: true });
    const path = this.getConfigPath(workspacePath);

    if (role === "setup") {
      const empty: AgentOsMcpServerConfig[] = [];
      await writeFile(path, JSON.stringify({ mcpServers: empty }, null, 2));
      return empty;
    }

    const rows = await this.store.listServers();
    const servers = rows.map((row) => {
      const headers = buildHeaders(row.headers, row.token);
      const entry: AgentOsMcpServerConfig & { id: string } = {
        id: row.id,
        type: "remote" as const,
        url: row.url,
        ...(headers ? { headers } : {}),
      };
      return entry;
    });
    await writeFile(path, JSON.stringify({ mcpServers: servers }, null, 2));
    return servers.map(({ id, ...config }) => config);
  }

  async warm(): Promise<void> {
    const rows = await this.store.listServers();
    const previous = this.pool;
    await previous?.close();
    this.pool = new McpPool(rows.map(rowToFlueConfig));
    if (rows.length > 0) {
      void this.pool.ready().catch((error) => {
        this.logger.log("error", "mcp-registry-warmup-failed", { error });
      });
    }
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    await pool?.close();
  }

  async addServer(
    input: McpServerInput,
  ): Promise<{ connection: McpServerConnection; toolCount: number }> {
    const pool = this.getPool();
    const connection = await pool.addServer(rowToFlueConfig(input));
    const toolCount = connection.tools.length;
    try {
      await this.store.addServer(input);
    } catch (error) {
      try {
        await pool.removeServer(input.id);
      } catch (rollbackError) {
        this.logger.log("warn", "mcp-registry-add-rollback-failed", {
          id: input.id,
          rollbackError,
        });
      }
      throw error;
    }
    return { connection, toolCount };
  }

  async removeServer(id: string): Promise<boolean> {
    const row = await this.store.getServer(id);
    const pool = this.getPool();
    const removedFromPool = await pool.removeServer(id);
    if (!row && !removedFromPool) return false;

    try {
      const removedFromDb = await this.store.removeServer(id);
      return removedFromDb || removedFromPool;
    } catch (error) {
      if (row && removedFromPool) {
        try {
          await pool.addServer(rowToFlueConfig(row));
        } catch (restoreError) {
          this.logger.log("warn", "mcp-registry-remove-restore-failed", {
            id,
            restoreError,
          });
        }
      }
      throw error;
    }
  }

  async tools(): Promise<ToolDefinition[]> {
    return this.pool?.tools() ?? [];
  }

  private getPool(): McpPoolLike {
    if (!this.pool) {
      this.pool = new McpPool();
    }
    return this.pool;
  }
}

export class McpRegistryConfigProvider implements McpConfigProvider {
  private workspacePath: string | undefined;

  constructor(private readonly registry: McpRegistry) {}

  setWorkspacePath(path: string): void {
    this.workspacePath = path;
  }

  async getPath(): Promise<string> {
    if (!this.workspacePath) {
      throw new Error("McpRegistryConfigProvider workspace path not set");
    }
    return this.registry.getConfigPath(this.workspacePath);
  }

  async parse(): Promise<unknown> {
    const path = await this.getPath();
    await this.registry.materializeConfig(this.workspacePath!, "coding");
    const content = await readFile(path, "utf8");
    return JSON.parse(content);
  }
}

let globalMcpRegistry: McpRegistry | undefined;

export function setGlobalMcpRegistry(registry: McpRegistry): void {
  globalMcpRegistry = registry;
}

export function getGlobalMcpRegistry(): McpRegistry | undefined {
  return globalMcpRegistry;
}

export function getMcpTools(): Promise<ToolDefinition[]> {
  return getGlobalMcpRegistry()?.tools() ?? Promise.resolve([]);
}

export class NoopMcpRegistry implements McpRegistry {
  async snapshot(): Promise<McpServerSnapshot[]> {
    return [];
  }

  getConfigPath(workspacePath: string): string {
    return join(workspacePath, ".mcp.json");
  }

  async materializeConfig(
    workspacePath: string,
    _role?: AgentTurnRole,
  ): Promise<AgentOsMcpServerConfig[]> {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      join(workspacePath, ".mcp.json"),
      JSON.stringify({ mcpServers: [] }, null, 2),
    );
    return [];
  }

  async warm(): Promise<void> {}
  async close(): Promise<void> {}

  async addServer(
    input: McpServerInput,
  ): Promise<{ connection: McpServerConnection; toolCount: number }> {
    throw new Error(
      `Cannot add MCP server "${input.id}"; no McpRegistry configured`,
    );
  }

  async removeServer(id: string): Promise<boolean> {
    throw new Error(
      `Cannot remove MCP server "${id}"; no McpRegistry configured`,
    );
  }

  async tools(): Promise<ToolDefinition[]> {
    return [];
  }
}

export function createNoopMcpRegistry(): McpRegistry {
  return new NoopMcpRegistry();
}

function rowToFlueConfig(row: McpServerRow | McpServerInput): FlueMcpServerConfig {
  const headers = buildHeaders(row.headers, row.token);
  return {
    id: row.id,
    url: row.url,
    ...(row.transport ? { transport: row.transport as McpTransport } : {}),
    ...(headers ? { headers } : {}),
  };
}

function defaultLogger(): Logger {
  return {
    log: (level, message, meta) => {
      console.log(`[threadcord] ${level}: ${message}`, meta ?? "");
    },
  };
}
