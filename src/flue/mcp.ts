import {
  connectMcpServer,
  type McpServerConnection,
  type McpServerOptions,
  type McpTransport,
  type ToolDefinition,
} from "@flue/runtime";

export interface McpServerConfig {
  id: string;
  url: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
}

/**
 * Manages live MCP server connections. Supports bulk startup loading via
 * {@link ready} and dynamic add/remove via {@link addServer}/{@link removeServer}.
 * Connections stay open until {@link close}; call it during application shutdown.
 */
export class McpPool {
  private readonly connections = new Map<string, McpServerConnection>();
  private connectPromise: Promise<void> | undefined;

  constructor(private readonly servers: McpServerConfig[] = []) {}

  /** Connects every initially-configured server once; safe to call concurrently. */
  ready(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.connectAll();
    }
    return this.connectPromise;
  }

  /** Adapted MCP tools across all reachable servers. */
  async tools(): Promise<ToolDefinition[]> {
    await this.ready();
    return [...this.connections.values()].flatMap(
      (connection) => connection.tools,
    );
  }

  /**
   * Connects a single MCP server and adds it to the pool.
   * Throws on connection failure so callers can report the error.
   * Throws if a server with the same id is already connected.
   */
  async addServer(config: McpServerConfig): Promise<McpServerConnection> {
    await this.ready();
    if (this.connections.has(config.id)) {
      throw new Error(`MCP server "${config.id}" is already connected.`);
    }
    const connection = await connectMcpServer(
      config.id,
      mcpConnectOptions(config),
    );
    this.connections.set(config.id, connection);
    return connection;
  }

  /**
   * Closes and removes a single MCP server connection.
   * Returns true if the server was found and removed, false otherwise.
   */
  async removeServer(id: string): Promise<boolean> {
    const connection = this.connections.get(id);
    if (!connection) return false;
    this.connections.delete(id);
    await connection.close().catch((error) => {
      console.warn(
        `[threadcord] Failed to close MCP connection "${id}"`,
        error,
      );
    });
    return true;
  }

  private async connectAll(): Promise<void> {
    await Promise.all(
      this.servers.map(async (server) => {
        try {
          const connection = await connectMcpServer(
            server.id,
            mcpConnectOptions(server),
          );
          this.connections.set(server.id, connection);
        } catch (error) {
          console.error(
            `[threadcord] Failed to connect MCP server "${server.id}"`,
            error,
          );
        }
      }),
    );
  }

  /** Closes every cached connection and resets the pool. */
  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.connectPromise = undefined;
    await Promise.all(
      connections.map((connection) =>
        connection.close().catch((error) => {
          console.warn("[threadcord] Failed to close MCP connection", error);
        }),
      ),
    );
  }
}

let mcpPool: McpPool | undefined;

function mcpConnectOptions(config: McpServerConfig): McpServerOptions {
  return {
    url: config.url,
    ...(config.transport ? { transport: config.transport } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
  };
}

function getOrCreatePool(servers?: McpServerConfig[]): McpPool {
  if (!mcpPool) {
    mcpPool = new McpPool(servers ?? []);
  }
  return mcpPool;
}

/** Returns the shared pool, creating it if needed. */
export function getMcpPool(): McpPool {
  return getOrCreatePool();
}

/** Eagerly connect configured MCP servers at startup; never throws. */
export async function warmMcpPool(servers: McpServerConfig[]): Promise<void> {
  if (servers.length === 0) {
    // Ensure the singleton exists even when no servers are configured,
    // so addServer works before any startup servers are loaded.
    getOrCreatePool(servers);
    return;
  }
  await getOrCreatePool(servers).ready();
}

/** Pooled MCP tools for an agent turn; empty when no servers are configured. */
export async function getMcpTools(): Promise<ToolDefinition[]> {
  return getOrCreatePool().tools();
}

/** Closes the shared MCP pool during application shutdown. */
export async function closeMcpPool(): Promise<void> {
  if (!mcpPool) return;
  const pool = mcpPool;
  mcpPool = undefined;
  await pool.close();
}
