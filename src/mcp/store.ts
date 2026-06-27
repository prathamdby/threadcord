import type { Pool, QueryResultRow } from "pg";

export interface McpServerRow {
  id: string;
  url: string;
  transport?: string;
  headers?: Record<string, string>;
  token?: string;
  createdAt: Date;
}

export interface McpServerInput {
  id: string;
  url: string;
  transport?: string;
  headers?: Record<string, string>;
  token?: string;
}

const ID_FORMAT = /^[a-z0-9-]+$/;

export class McpStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        transport TEXT,
        headers_json JSONB,
        token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async addServer(input: McpServerInput): Promise<McpServerRow> {
    validateServerId(input.id);
    const result = await this.pool.query(
      `
        INSERT INTO mcp_servers (id, url, transport, headers_json, token)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        RETURNING *
      `,
      [
        input.id,
        input.url,
        input.transport ?? null,
        input.headers ? JSON.stringify(input.headers) : null,
        input.token ?? null,
      ],
    );
    return rowToServer(singleRow(result.rows));
  }

  async removeServer(id: string): Promise<boolean> {
    validateServerId(id);
    const result = await this.pool.query(
      "DELETE FROM mcp_servers WHERE id = $1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getServer(id: string): Promise<McpServerRow | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM mcp_servers WHERE id = $1",
      [id],
    );
    return result.rows[0] ? rowToServer(result.rows[0]) : undefined;
  }

  async listServers(): Promise<McpServerRow[]> {
    const result = await this.pool.query(
      "SELECT * FROM mcp_servers ORDER BY id",
    );
    return result.rows.map((row) => rowToServer(row));
  }
}

function validateServerId(id: string): void {
  if (!ID_FORMAT.test(id)) {
    throw new Error(
      `Invalid MCP server id "${id}". Use lowercase letters, numbers, and hyphens only.`,
    );
  }
}

function parseStoredHeaders(value: unknown): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers = value as Record<string, unknown>;
  if (Object.values(headers).some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return headers as Record<string, string>;
}

function rowToServer(row: QueryResultRow): McpServerRow {
  const headers = parseStoredHeaders(row.headers_json);
  return {
    id: String(row.id),
    url: String(row.url),
    ...(typeof row.transport === "string" ? { transport: row.transport } : {}),
    ...(headers ? { headers } : {}),
    ...(typeof row.token === "string" ? { token: row.token } : {}),
    createdAt: new Date(String(row.created_at)),
  };
}

function singleRow<T extends QueryResultRow>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("Expected one row");
  return row;
}
