import { describe, expect, it } from "vitest";
import { toAcpMcpServer } from "../src/mcp/acp-config.js";
import type { McpServerRow } from "../src/mcp/store.js";

function row(overrides: Partial<McpServerRow> & Pick<McpServerRow, "id" | "url">): McpServerRow {
  return {
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toAcpMcpServer", () => {
  it("maps sse transport to ACP session/new shape with header array", () => {
    const config = toAcpMcpServer(
      row({
        id: "context7",
        url: "https://mcp.context7.com/mcp",
        transport: "sse",
        token: "tok-abc",
      }),
    );

    expect(config).toEqual({
      type: "sse",
      name: "context7",
      url: "https://mcp.context7.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer tok-abc" }],
    });
  });

  it("maps streamable-http transport to ACP http type", () => {
    const config = toAcpMcpServer(
      row({
        id: "server-a",
        url: "https://a.example.com",
        transport: "streamable-http",
      }),
    );

    expect(config).toEqual({
      type: "http",
      name: "server-a",
      url: "https://a.example.com",
      headers: [],
    });
  });

  it("defaults missing transport to ACP http type with empty headers", () => {
    const config = toAcpMcpServer(
      row({
        id: "server-b",
        url: "https://b.example.com",
      }),
    );

    expect(config).toEqual({
      type: "http",
      name: "server-b",
      url: "https://b.example.com",
      headers: [],
    });
  });
});
