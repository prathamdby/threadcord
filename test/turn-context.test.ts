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
  setupProfileRevision: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("checkoutPathForTask", () => {
  it("places the repo checkout under the task workspace", () => {
    expect(checkoutPathForTask(task)).toBe("/workspaces/task-1/web");
  });
});
