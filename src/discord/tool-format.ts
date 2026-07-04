import {
  shortenPreviewString,
  shortenWorkspacePathsInText,
} from "./tool-preview-path.js";

export const PREVIEW_CAP = 40;

export interface FormatToolPreviewOptions {
  /** Repo checkout root used to shorten absolute paths in previews. */
  repoRoot?: string;
}

const TOOL_EMOJI: Record<string, string> = {
  bash: "💻",
  terminal: "💻",
  read_file: "📖",
  read: "📖",
  write_file: "✍️",
  write: "✍️",
  edit_file: "🔧",
  edit: "🔧",
  str_replace: "🔧",
  patch: "🔧",
  search_files: "🔎",
  grep: "🔎",
  glob: "🔎",
  web_search: "🔍",
  create_github_pull_request: "🔧",
  skill: "🧭",
};

const PRIMARY_ARG: Record<string, string> = {
  bash: "command",
  terminal: "command",
  read_file: "path",
  read: "path",
  write_file: "path",
  write: "path",
  edit_file: "path",
  edit: "path",
  str_replace: "path",
  patch: "path",
  search_files: "pattern",
  grep: "pattern",
  glob: "pattern",
  web_search: "query",
  create_github_pull_request: "title",
  skill: "action",
};

const TERMINAL_TOOLS = new Set(["bash", "terminal"]);
const DEFAULT_EMOJI = "⚙️";
const ELLIPSIS = "…";

/** Short user-facing text for failed tool rows in Discord progress (no raw errors). */
export const TOOL_CALL_GENERIC_ERROR = "tool call failed";

/** Discord-facing tool label (MCP tools: mcp__server__tool -> "server tool"). */
export function displayToolName(toolName: string): string {
  if (!toolName.startsWith("mcp__")) {
    return toolName;
  }
  const parts = toolName.split("__").filter((p) => p.length > 0);
  if (parts[0] === "mcp") {
    parts.shift();
  }
  if (parts.length === 0) {
    return toolName;
  }
  if (parts.length === 1) {
    return parts[0]!.replaceAll("_", " ");
  }
  const server = parts[0]!;
  const rest = parts.slice(1).join("_").replaceAll("_", " ");
  return `${server} ${rest}`;
}

export function getToolEmoji(toolName: string): string {
  return TOOL_EMOJI[toolName] ?? DEFAULT_EMOJI;
}

export function isTerminalTool(toolName: string): boolean {
  return TERMINAL_TOOLS.has(toolName);
}

function asRecord(args: unknown): Record<string, unknown> | undefined {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return undefined;
}

function firstStringField(record: Record<string, unknown>): string | undefined {
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function capPreview(value: string): string {
  if (value.length <= PREVIEW_CAP) return value;
  return `${value.slice(0, PREVIEW_CAP - 3)}...`;
}

export function buildToolPreview(
  toolName: string,
  args: unknown,
  options?: FormatToolPreviewOptions,
): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  const key = PRIMARY_ARG[toolName];
  if (key !== undefined) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      const display =
        key === "path"
          ? shortenPreviewString(value, toolName, options?.repoRoot)
          : value;
      return capPreview(display);
    }
    return undefined;
  }
  const fallback = firstStringField(record);
  if (fallback === undefined) return undefined;
  return capPreview(
    shortenPreviewString(fallback, toolName, options?.repoRoot),
  );
}

function terminalCommand(
  toolName: string,
  args: unknown,
  options?: FormatToolPreviewOptions,
): string | undefined {
  if (!isTerminalTool(toolName)) return undefined;
  const record = asRecord(args);
  if (!record) return undefined;
  const command = record["command"];
  if (typeof command === "string" && command.length > 0) {
    return shortenWorkspacePathsInText(command, options?.repoRoot);
  }
  return undefined;
}

export function isTerminalBlock(toolName: string, args: unknown): boolean {
  return terminalCommand(toolName, args) !== undefined;
}

function terminalBody(command: string): string {
  const newlineIdx = command.indexOf("\n");
  const firstLine = newlineIdx === -1 ? command : command.slice(0, newlineIdx);
  const multiline = newlineIdx !== -1;
  let body = firstLine;
  if (body.length > PREVIEW_CAP) {
    body = `${body.slice(0, PREVIEW_CAP - 3)}...`;
  }
  if (multiline) {
    body = `${body} ${ELLIPSIS}`;
  }
  return body;
}

function mcpPrimaryArgKey(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const lower = toolName.toLowerCase();
  if (lower.includes("search") || lower.includes("fetch")) {
    return "query";
  }
  return undefined;
}

function buildToolPreviewWithMcp(
  toolName: string,
  args: unknown,
  options?: FormatToolPreviewOptions,
): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  const mcpKey = mcpPrimaryArgKey(toolName);
  if (mcpKey !== undefined) {
    const value = record[mcpKey];
    if (typeof value === "string" && value.length > 0) {
      return capPreview(value);
    }
  }
  return buildToolPreview(toolName, args, options);
}

export function formatToolLine(
  toolName: string,
  args: unknown,
  options?: FormatToolPreviewOptions,
): string {
  const label = displayToolName(toolName);
  const emoji = getToolEmoji(toolName);
  const command = terminalCommand(toolName, args, options);
  if (command !== undefined) {
    return `${emoji} ${label}\n\`\`\`\n${terminalBody(command)}\n\`\`\``;
  }
  const preview = buildToolPreviewWithMcp(toolName, args, options);
  if (preview !== undefined) {
    return `${emoji} ${label}: "${preview}"`;
  }
  return `${emoji} ${label}${ELLIPSIS}`;
}

export function formatToolFailureLine(
  toolName: string,
  args: unknown,
  options?: FormatToolPreviewOptions,
): string {
  const label = displayToolName(toolName);
  const emoji = getToolEmoji(toolName);
  const command = terminalCommand(toolName, args, options);
  if (command !== undefined) {
    return `${emoji} ${label}: ${TOOL_CALL_GENERIC_ERROR}`;
  }
  const preview = buildToolPreviewWithMcp(toolName, args, options);
  if (preview !== undefined) {
    return `${emoji} ${label}: "${preview}" — ${TOOL_CALL_GENERIC_ERROR}`;
  }
  return `${emoji} ${label}: ${TOOL_CALL_GENERIC_ERROR}`;
}
