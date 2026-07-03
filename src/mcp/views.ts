import { listView, type ViewPayload } from "../discord/ui/index.js";
import type { McpServerRow } from "./store.js";
import { mcpListPageId } from "./custom-id.js";

export function formatServerLine(server: McpServerRow): string {
  const transport = server.transport ?? "streamable-http";
  return `• \`${server.id}\` — ${server.url} (${transport})`;
}

export function mcpListView(
  servers: McpServerRow[],
  page: number,
  userId: string,
): ViewPayload {
  const items = servers.map(formatServerLine);
  return listView(
    `MCP Servers (${servers.length})`,
    items,
    page,
    25,
    (nextPage) => mcpListPageId(userId, nextPage),
  );
}
