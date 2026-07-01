import type { McpServerRow } from "./store.js";
import { buildHeaders } from "./validation.js";

export interface AcpHttpHeader {
  name: string;
  value: string;
}

export interface AcpMcpServerConfig {
  type: "http" | "sse";
  name: string;
  url: string;
  headers: AcpHttpHeader[];
}

export function toAcpMcpServer(row: McpServerRow): AcpMcpServerConfig {
  const headerRecord = buildHeaders(row.headers, row.token);
  const transport = row.transport ?? "streamable-http";
  return {
    type: transport === "sse" ? "sse" : "http",
    name: row.id,
    url: row.url,
    headers: Object.entries(headerRecord ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
  };
}
