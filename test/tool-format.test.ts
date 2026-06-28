import { describe, expect, it } from "vitest";
import {
  TOOL_CALL_GENERIC_ERROR,
  buildToolPreview,
  displayToolName,
  formatToolFailureLine,
  formatToolLine,
  getToolEmoji,
  isTerminalBlock,
  isTerminalTool,
} from "../src/discord/tool-format.js";

describe("displayToolName", () => {
  it("leaves built-in tool names unchanged", () => {
    expect(displayToolName("read")).toBe("read");
  });

  it("formats MCP tool names with server and action", () => {
    expect(displayToolName("mcp__exa__web_search_exa")).toBe(
      "exa web search exa",
    );
  });
});

describe("getToolEmoji", () => {
  it.each([
    ["bash", "💻"],
    ["terminal", "💻"],
    ["read_file", "📖"],
    ["read", "📖"],
    ["write_file", "✍️"],
    ["edit_file", "🔧"],
    ["patch", "🔧"],
    ["search_files", "🔎"],
    ["grep", "🔎"],
    ["glob", "🔎"],
    ["web_search", "🔍"],
    ["create_github_pull_request", "🔧"],
    ["some_mcp_tool", "⚙️"],
  ])("returns the emoji for %s", (toolName, emoji) => {
    expect(getToolEmoji(toolName)).toBe(emoji);
  });
});

describe("buildToolPreview", () => {
  it("returns the mapped primary arg", () => {
    expect(buildToolPreview("read_file", { path: "src/main.py" })).toBe(
      "src/main.py",
    );
  });

  it("returns the command for bash", () => {
    expect(buildToolPreview("bash", { command: "pytest -q" })).toBe(
      "pytest -q",
    );
  });

  it("returns undefined when the primary arg is missing", () => {
    expect(buildToolPreview("read_file", {})).toBeUndefined();
  });

  it("returns undefined when the primary arg is empty", () => {
    expect(buildToolPreview("read_file", { path: "" })).toBeUndefined();
  });

  it("falls back to the first string field for unknown tools", () => {
    expect(buildToolPreview("mcp_x", { a: "first", b: "second" })).toBe(
      "first",
    );
  });

  it("returns undefined when args has no string fields", () => {
    expect(buildToolPreview("mcp_x", { n: 1, b: true })).toBeUndefined();
  });

  it("returns undefined when args is not a record", () => {
    expect(buildToolPreview("mcp_x", "not-a-record")).toBeUndefined();
    expect(buildToolPreview("mcp_x", null)).toBeUndefined();
    expect(buildToolPreview("mcp_x", undefined)).toBeUndefined();
    expect(buildToolPreview("mcp_x", ["array"])).toBeUndefined();
  });

  it("caps previews longer than 40 chars", () => {
    expect(buildToolPreview("read_file", { path: "x".repeat(50) })).toBe(
      `${"x".repeat(37)}...`,
    );
  });
});

describe("isTerminalTool / isTerminalBlock", () => {
  it("flags bash and terminal as terminal tools", () => {
    expect(isTerminalTool("bash")).toBe(true);
    expect(isTerminalTool("terminal")).toBe(true);
    expect(isTerminalTool("read_file")).toBe(false);
  });

  it("treats bash with a non-empty command as a terminal block", () => {
    expect(isTerminalBlock("bash", { command: "echo hi" })).toBe(true);
  });

  it("does not treat bash with an empty command as a terminal block", () => {
    expect(isTerminalBlock("bash", { command: "" })).toBe(false);
    expect(isTerminalBlock("bash", {})).toBe(false);
  });

  it("does not treat non-terminal tools as terminal blocks", () => {
    expect(isTerminalBlock("read_file", { path: "src/main.py" })).toBe(false);
  });
});

describe("formatToolLine", () => {
  it.each([
    ["read_file", { path: "src/main.py" }, '📖 read_file: "src/main.py"'],
    ["read", { path: "a.ts" }, '📖 read: "a.ts"'],
    ["write_file", { path: "out.txt" }, '✍️ write_file: "out.txt"'],
    ["edit_file", { path: "src/auth.ts" }, '🔧 edit_file: "src/auth.ts"'],
    ["grep", { pattern: "TODO" }, '🔎 grep: "TODO"'],
    [
      "web_search",
      { query: "vitest fake timers" },
      '🔍 web_search: "vitest fake timers"',
    ],
    [
      "create_github_pull_request",
      { title: "feat: add auth" },
      '🔧 create_github_pull_request: "feat: add auth"',
    ],
    ["bash", { command: "pytest -q" }, "💻 bash\n```\npytest -q\n```"],
    [
      "terminal",
      { command: "make build" },
      "💻 terminal\n```\nmake build\n```",
    ],
    ["mcp_unknown", { foo: "bar" }, '⚙️ mcp_unknown: "bar"'],
    ["mcp_unknown", { foo: 123 }, "⚙️ mcp_unknown…"],
    ["mcp_unknown", {}, "⚙️ mcp_unknown…"],
    ["mcp_unknown", undefined, "⚙️ mcp_unknown…"],
    ["bash", { command: "" }, "💻 bash…"],
    ["bash", {}, "💻 bash…"],
  ])("renders %s with %j as %s", (toolName, args, expected) => {
    expect(formatToolLine(toolName, args)).toBe(expected);
  });

  it("renders a multiline bash command as a single-line capped code block", () => {
    expect(formatToolLine("bash", { command: "git add -A\ngit commit" })).toBe(
      "💻 bash\n```\ngit add -A …\n```",
    );
  });

  it("caps and marks a long multiline bash command", () => {
    expect(formatToolLine("bash", { command: `${"x".repeat(50)}\nmore` })).toBe(
      `💻 bash\n\`\`\`\n${"x".repeat(37)}... …\n\`\`\``,
    );
  });

  it("truncates a long bash command first line with ...", () => {
    expect(formatToolLine("bash", { command: "x".repeat(50) })).toBe(
      `💻 bash\n\`\`\`\n${"x".repeat(37)}...\n\`\`\``,
    );
  });

  it("truncates a long non-terminal preview with ... inside the quotes", () => {
    expect(formatToolLine("read_file", { path: "x".repeat(50) })).toBe(
      `📖 read_file: "${"x".repeat(37)}..."`,
    );
  });

  it("formats MCP search tools with spaced labels and query preview", () => {
    expect(
      formatToolLine("mcp__exa__web_search_exa", {
        query: "threadcord discord tools",
      }),
    ).toBe('⚙️ exa web search exa: "threadcord discord tools"');
  });
});

describe("formatToolFailureLine", () => {
  it("shows generic error inline for bash failures", () => {
    expect(formatToolFailureLine("bash", { command: "npm test" })).toBe(
      `💻 bash: ${TOOL_CALL_GENERIC_ERROR}`,
    );
  });

  it("keeps preview and adds generic error inline for non-terminal tools", () => {
    expect(formatToolFailureLine("glob", { pattern: "**/*.ts" })).toBe(
      `🔎 glob: "**/*.ts" — ${TOOL_CALL_GENERIC_ERROR}`,
    );
  });
});
