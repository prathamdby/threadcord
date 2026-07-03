import { buildCustomId, parseCustomId } from "../discord/ui/index.js";

export function mcpAddModalId(userId: string): string {
  return buildCustomId("mcp", "add", userId);
}

export function mcpRemoveSelectId(userId: string): string {
  return buildCustomId("mcp", "remove", "sel", userId);
}

export function mcpRemoveConfirmId(userId: string, serverId: string): string {
  return buildCustomId("mcp", "remove", "confirm", userId, serverId);
}

export function mcpRemoveCancelId(userId: string, serverId: string): string {
  return buildCustomId("mcp", "remove", "cancel", userId, serverId);
}

export function mcpListPageId(userId: string, page: number): string {
  return buildCustomId("mcp", "list", "page", userId, String(page));
}

export function parseMcpAddModalId(raw: string): { userId: string } | null {
  const parsed = parseCustomId(raw);
  if (!parsed || parsed.ns !== "mcp" || parsed.action !== "add") return null;
  const userId = parsed.params[0];
  if (!userId) return null;
  return { userId };
}

export function parseMcpRemoveSelectId(raw: string): { userId: string } | null {
  const parsed = parseCustomId(raw);
  if (
    !parsed ||
    parsed.ns !== "mcp" ||
    parsed.action !== "remove" ||
    parsed.params[0] !== "sel"
  ) {
    return null;
  }
  const userId = parsed.params[1];
  if (!userId) return null;
  return { userId };
}

export function parseMcpRemoveConfirmId(
  raw: string,
): { userId: string; serverId: string } | null {
  const parsed = parseCustomId(raw);
  if (
    !parsed ||
    parsed.ns !== "mcp" ||
    parsed.action !== "remove" ||
    parsed.params[0] !== "confirm"
  ) {
    return null;
  }
  const userId = parsed.params[1];
  const serverId = parsed.params[2];
  if (!userId || !serverId) return null;
  return { userId, serverId };
}

export function parseMcpRemoveCancelId(
  raw: string,
): { userId: string; serverId: string } | null {
  const parsed = parseCustomId(raw);
  if (
    !parsed ||
    parsed.ns !== "mcp" ||
    parsed.action !== "remove" ||
    parsed.params[0] !== "cancel"
  ) {
    return null;
  }
  const userId = parsed.params[1];
  const serverId = parsed.params[2];
  if (!userId || !serverId) return null;
  return { userId, serverId };
}

export function parseMcpListPageId(
  raw: string,
): { userId: string; page: number } | null {
  const parsed = parseCustomId(raw);
  if (
    !parsed ||
    parsed.ns !== "mcp" ||
    parsed.action !== "list" ||
    parsed.params[0] !== "page"
  ) {
    return null;
  }
  const userId = parsed.params[1];
  const pageRaw = parsed.params[2];
  if (!userId || pageRaw === undefined) return null;
  const page = Number.parseInt(pageRaw, 10);
  if (!Number.isFinite(page)) return null;
  return { userId, page };
}
