import { describe, expect, it } from "vitest";
import { checkoutPathForTask } from "../src/task/turn-context.js";
import type { TaskRecord } from "../src/types.js";

const task: TaskRecord = {
  id: "task-1",
  discordMessageId: "msg-1",
  discordThreadId: "thread-1",
  flueInstanceId: "discord:thread:thread-1",
  workspacePath: "/workspaces/task-1",
  repo: "acme/web",
  branch: "main",
  model: "anthropic/claude-sonnet-4-5",
  instruction: "Fix it",
  status: "running",
  initialTurnStarted: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("checkoutPathForTask", () => {
  it("places the repo checkout under the task workspace", () => {
    expect(checkoutPathForTask(task)).toBe("/workspaces/task-1/web");
  });

  it("preserves the stored repository basename for existing mixed-case tasks", () => {
    expect(checkoutPathForTask({ ...task, repo: "Acme/Web.UI" })).toBe(
      "/workspaces/task-1/Web.UI",
    );
  });

  it("allows dot-prefixed repository names under the task workspace", () => {
    expect(checkoutPathForTask({ ...task, repo: "acme/..foo" })).toBe(
      "/workspaces/task-1/..foo",
    );
  });

  it("refuses path-like repository records before deriving a checkout path", () => {
    expect(() =>
      checkoutPathForTask({ ...task, repo: "acme/../../outside" }),
    ).toThrow("Task repository is invalid. Refusing to derive checkout path.");
  });
});
