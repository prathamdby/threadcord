import { describe, expect, it } from "vitest";
import { assertPathInsideWorkspace } from "../src/task/bootstrap.js";

describe("assertPathInsideWorkspace", () => {
  it("allows a normal checkout path under the workspace", () => {
    expect(() =>
      assertPathInsideWorkspace("/workspaces/task-1/web", "/workspaces/task-1"),
    ).not.toThrow();
  });

  it("allows a deeply nested checkout path", () => {
    expect(() =>
      assertPathInsideWorkspace(
        "/workspaces/task-1/a/b/c",
        "/workspaces/task-1",
      ),
    ).not.toThrow();
  });

  it("rejects an identical path (no descent)", () => {
    expect(() =>
      assertPathInsideWorkspace("/workspaces/task-1", "/workspaces/task-1"),
    ).toThrow("escaped");
  });

  it("rejects a path that escapes via parent traversal", () => {
    expect(() =>
      assertPathInsideWorkspace(
        "/workspaces/task-1/../etc",
        "/workspaces/task-1",
      ),
    ).toThrow("escaped");
  });

  it("rejects a fully unrelated path", () => {
    expect(() =>
      assertPathInsideWorkspace("/etc/passwd", "/workspaces/task-1"),
    ).toThrow("escaped");
  });

  it("rejets a path that is a sibling of the workspace root", () => {
    expect(() =>
      assertPathInsideWorkspace(
        "/workspaces/other-task/web",
        "/workspaces/task-1",
      ),
    ).toThrow("escaped");
  });
});
