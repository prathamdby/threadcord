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

const MCP_CONNECT_TIMEOUT_MS = 10_000;

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
    let failures = 0;
    await Promise.all(
      this.servers.map(async (server) => {
        try {
          const connection = await connectWithTimeout(server);
          if (!this.connectPromise) {
            void connection.close().catch(() => {});
            return;
          }
          this.connections.set(server.id, connection);
        } catch (error) {
          failures++;
          console.error(
            `[threadcord] Failed to connect MCP server "${server.id}"`,
            error,
          );
        }
      }),
    );
    if (this.servers.length > 0 && failures === this.servers.length) {
      console.warn(
        `[threadcord] All ${this.servers.length} configured MCP server(s) failed to connect`,
      );
    }
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

async function connectWithTimeout(
  server: McpServerConfig,
): Promise<McpServerConnection> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const connectionPromise = connectMcpServer(
    server.id,
    mcpConnectOptions(server),
  );
  try {
    return await Promise.race([
      connectionPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              `MCP server "${server.id}" connect timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`,
            ),
          );
        }, MCP_CONNECT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      void connectionPromise
        .then((connection) => connection.close())
        .catch(() => {});
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getMcpPoolOrThrow(): McpPool {
  if (!mcpPool) {
    throw new Error("MCP pool not initialized; call warmMcpPool first");
  }
  return mcpPool;
}

/** Returns the shared pool after startup initialization. */
export function getMcpPool(): McpPool {
  return getMcpPoolOrThrow();
}

/** Initialize the shared MCP pool; connections finish in the background. */
export function warmMcpPool(servers: McpServerConfig[]): void {
  const previous = mcpPool;
  mcpPool = new McpPool(servers);
  if (previous) {
    void previous.close();
  }
  if (servers.length > 0) {
    void mcpPool.ready().catch((error) => {
      console.error("[threadcord] MCP pool warmup failed", error);
    });
  }
}

/** Pooled MCP tools for an agent turn; empty when no servers are configured. */
export async function getMcpTools(): Promise<ToolDefinition[]> {
  if (!mcpPool) return [];
  return mcpPool.tools();
}

/** Closes the shared MCP pool during application shutdown. */
export async function closeMcpPool(): Promise<void> {
  if (!mcpPool) return;
  const pool = mcpPool;
  await pool.close();
  if (mcpPool === pool) {
    mcpPool = undefined;
  }
}
