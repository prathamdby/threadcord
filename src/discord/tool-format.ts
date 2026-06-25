import {
  shortenPathForPreview,
  toolPreviewUsesPath,
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
  str_replace: "🔧",
  patch: "🔧",
  search_files: "🔎",
  grep: "🔎",
  glob: "🔎",
  web_search: "🔍",
  create_github_pull_request: "🔧",
};

const PRIMARY_ARG: Record<string, string> = {
  bash: "command",
  terminal: "command",
  read_file: "path",
  read: "path",
  write_file: "path",
  write: "path",
  edit_file: "path",
  str_replace: "path",
  patch: "path",
  search_files: "pattern",
  grep: "pattern",
  glob: "pattern",
  web_search: "query",
  create_github_pull_request: "title",
};

const TERMINAL_TOOLS = new Set(["bash", "terminal"]);
const DEFAULT_EMOJI = "⚙️";
const ELLIPSIS = "…";

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
        key === "path" && toolPreviewUsesPath(toolName)
          ? shortenPathForPreview(value, options?.repoRoot)
          : value;
      return capPreview(display);
    }
    return undefined;
  }
  const fallback = firstStringField(record);
  return fallback !== undefined ? capPreview(fallback) : undefined;
}

function terminalCommand(toolName: string, args: unknown): string | undefined {
  if (!isTerminalTool(toolName)) return undefined;
  const record = asRecord(args);
  if (!record) return undefined;
  const command = record["command"];
  if (typeof command === "string" && command.length > 0) {
    return command;
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

export function formatToolLine(
  toolName: string,
  args: unknown,
  options?: FormatToolPreviewOptions,
): string {
  const emoji = getToolEmoji(toolName);
  const command = terminalCommand(toolName, args);
  if (command !== undefined) {
    return `${emoji} ${toolName}\n\`\`\`\n${terminalBody(command)}\n\`\`\``;
  }
  const preview = buildToolPreview(toolName, args, options);
  if (preview !== undefined) {
    return `${emoji} ${toolName}: "${preview}"`;
  }
  return `${emoji} ${toolName}${ELLIPSIS}`;
}