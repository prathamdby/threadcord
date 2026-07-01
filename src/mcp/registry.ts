import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig as AgentOsMcpServerConfig } from "@rivet-dev/agentos-core";
export type { McpServerConfig as AgentOsMcpServerConfig } from "@rivet-dev/agentos-core";
import type { AcpMcpServerConfig } from "./acp-config.js";
import { toAcpMcpServer } from "./acp-config.js";
import type { McpConfigProvider } from "../agentturn/machine-environment.js";
import type { AgentTurnRole } from "../agentturn/types.js";
import type { McpServerInput, McpStore } from "./store.js";

export interface Logger {
  log(level: string, message: string, meta?: Record<string, unknown>): void;
}

export interface McpServerSnapshot {
  id: string;
  url: string;
  transport?: string;
  headers?: Record<string, string>;
}

export interface McpRegistry {
  /** Sanitized snapshot of registered servers (no raw token fields). */
  snapshot(): Promise<McpServerSnapshot[]>;
  /** Returns the path where the agent-specific MCP config is written. */
  getConfigPath(workspacePath: string): string;
  /** Writes the agent-specific `.mcp.json` config and returns ACP session/new MCP servers. */
  materializeConfig(
    workspacePath: string,
    role?: AgentTurnRole,
  ): Promise<AcpMcpServerConfig[]>;
  /** Load persisted servers into the live connection pool (AgentOS manages its own pool). */
  warm(): Promise<void>;
  /** Close the live connection pool (AgentOS manages its own pool). */
  close(): Promise<void>;
  /** Validate and persist a new server. */
  addServer(input: McpServerInput): Promise<{ toolCount: number }>;
  /** Delete the server row. */
  removeServer(id: string): Promise<boolean>;
  /** Return the list of tools available from connected servers (empty for AgentOS-managed pools). */
  tools(): Promise<ToolDefinition[]>;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpRegistryDependencies {
  store: McpStore;
  logger?: Logger;
}

export class DefaultMcpRegistry implements McpRegistry {
  private readonly store: McpStore;
  private readonly logger: Logger;

  constructor(deps: McpRegistryDependencies) {
    this.store = deps.store;
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
  ): Promise<AcpMcpServerConfig[]> {
    await mkdir(workspacePath, { recursive: true });
    const path = this.getConfigPath(workspacePath);

    if (role === "setup") {
      const empty: AcpMcpServerConfig[] = [];
      await writeFile(path, JSON.stringify({ mcpServers: empty }, null, 2));
      return empty;
    }

    const rows = await this.store.listServers();
    const servers = rows.map((row) => ({
      id: row.id,
      ...toAcpMcpServer(row),
    }));
    await writeFile(path, JSON.stringify({ mcpServers: servers }, null, 2));
    return servers.map(({ id, ...config }) => config);
  }

  async warm(): Promise<void> {
    // AgentOS handles MCP connection lifecycle directly.
    // This method remains on the interface for compatibility but is a no-op.
    this.logger.log("info", "mcp-registry-warm", { serverCount: (await this.store.listServers()).length });
  }

  async close(): Promise<void> {
    // AgentOS manages its own MCP connection pool; nothing to close here.
  }

  async addServer(input: McpServerInput): Promise<{ toolCount: number }> {
    await this.store.addServer(input);
    // AgentOS discovers tools from the persisted .mcp.json at session creation time.
    return { toolCount: 0 };
  }

  async removeServer(id: string): Promise<boolean> {
    return this.store.removeServer(id);
  }

  async tools(): Promise<ToolDefinition[]> {
    return [];
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
  ): Promise<AcpMcpServerConfig[]> {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      join(workspacePath, ".mcp.json"),
      JSON.stringify({ mcpServers: [] }, null, 2),
    );
    return [];
  }

  async warm(): Promise<void> {}
  async close(): Promise<void> {}

  async addServer(input: McpServerInput): Promise<{ toolCount: number }> {
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

function defaultLogger(): Logger {
  return {
    log: (level, message, meta) => {
      console.log(`[threadcord] ${level}: ${message}`, meta ?? "");
    },
  };
}
