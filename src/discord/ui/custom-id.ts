export const CUSTOM_ID_MAX_LENGTH = 100;

export type UiNamespace = "task" | "setup" | "mcp";

const NAMESPACES: readonly UiNamespace[] = ["task", "setup", "mcp"];

export interface ParsedCustomId {
  ns: UiNamespace;
  action: string;
  params: string[];
}

export function buildCustomId(
  ns: UiNamespace,
  action: string,
  ...params: string[]
): string {
  const raw = [ns, action, ...params].join(":");
  if (raw.length > CUSTOM_ID_MAX_LENGTH) {
    throw new Error(
      `Custom id exceeds ${CUSTOM_ID_MAX_LENGTH} chars (${raw.length}): ${ns}:${action}`,
    );
  }
  return raw;
}

export function parseCustomId(raw: string): ParsedCustomId | null {
  if (raw.length > CUSTOM_ID_MAX_LENGTH) return null;
  const [ns, action, ...params] = raw.split(":");
  if (!ns || !action) return null;
  if (!NAMESPACES.includes(ns as UiNamespace)) return null;
  return { ns: ns as UiNamespace, action, params };
}
