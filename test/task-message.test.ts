import { describe, expect, it } from "vitest";
import { parseTaskMessage } from "../src/task/parser.js";

describe("parseTaskMessage", () => {
  it("accepts a task when instruction precedes keyed fields", () => {
    const result = parseTaskMessage(
      [
        "Fix the failing auth test and open a PR.",
        "",
        "repo: acme/web",
        "branch: main",
        "model: anthropic/claude-sonnet-4-5",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: true,
      request: {
        instruction: "Fix the failing auth test and open a PR.",
        repo: "acme/web",
        branch: "main",
        model: "anthropic/claude-sonnet-4-5",
      },
    });
  });

  it("parses optional push override and case-insensitive field names", () => {
    const result = parseTaskMessage(
      [
        "Ship the fix.",
        "REPO: acme/web",
        "Branch: main",
        "MODEL: anthropic/claude-sonnet-4-5",
        "push: main",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: true,
      request: {
        instruction: "Ship the fix.",
        pushOverride: "main",
      },
    });
  });

  it("rejects messages with no instruction prose", () => {
    const result = parseTaskMessage(
      [
        "repo: acme/web",
        "branch: main",
        "model: anthropic/claude-sonnet-4-5",
      ].join("\n"),
    );

    expect(result).toEqual({
      ok: false,
      message: "Missing task instruction before the keyed fields.",
    });
  });

  it("allows attachment-only messages when hasAttachments is set", () => {
    const result = parseTaskMessage(
      ["repo: acme/web", "branch: main"].join("\n"),
      { hasAttachments: true },
    );

    expect(result).toMatchObject({
      ok: true,
      request: {
        instruction: "",
        repo: "acme/web",
        branch: "main",
      },
    });
  });

  it("rejects messages missing required keyed fields", () => {
    const result = parseTaskMessage(
      ["Do the thing.", "repo: acme/web"].join("\n"),
    );

    expect(result).toEqual({
      ok: false,
      message: "Missing required field: branch",
    });
  });

  it("accepts messages without model when repo and branch are present", () => {
    const result = parseTaskMessage(
      [
        "Fix the failing auth test and open a PR.",
        "",
        "repo: acme/web",
        "branch: main",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: true,
      request: {
        instruction: "Fix the failing auth test and open a PR.",
        repo: "acme/web",
        branch: "main",
      },
    });
    expect(result.ok && result.request.model).toBeUndefined();
  });

  it("keeps prose with colons when the key is not a known metadata field", () => {
    const result = parseTaskMessage(
      [
        "Summary: fix flaky login test",
        "",
        "repo: acme/web",
        "branch: main",
        "model: anthropic/claude-sonnet-4-5",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: true,
      request: {
        instruction: "Summary: fix flaky login test",
        repo: "acme/web",
        branch: "main",
        model: "anthropic/claude-sonnet-4-5",
      },
    });
  });

  it("handles Windows line endings", () => {
    const result = parseTaskMessage(
      "Fix it.\r\nrepo: acme/web\r\nbranch: main\r\nmodel: anthropic/claude-sonnet-4-5",
    );

    expect(result).toMatchObject({
      ok: true,
      request: { instruction: "Fix it." },
    });
  });
});
