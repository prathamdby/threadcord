import { describe, expect, it } from "vitest";
import {
  agentRuntimeContextFromTask,
  checkoutPathForTask,
} from "../src/task/turn-context.js";
import type { SetupProfile } from "../src/setup/profile.js";
import type { TaskRecord } from "../src/types.js";

const task: TaskRecord = {
  id: "task-1",
  discordMessageId: "msg-1",
  discordThreadId: "thread-1",
  agentInstanceId: "discord:thread:thread-1",
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

const readyProfile: SetupProfile = {
  id: "profile-1",
  repo: "acme/web",
  branch: "main",
  status: "ready",
  revision: 2,
  environment: {
    install: "npm ci",
    start: "",
    checks: { test: "npm test", lint: "npm run lint" },
    requiredEnv: ["API_KEY"],
    requiredServices: [],
  },
  memoryMarkdown: "setup memory",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("checkoutPathForTask", () => {
  it("places the repo checkout under the task workspace", () => {
    expect(checkoutPathForTask(task)).toBe("/workspaces/task-1/web");
  });
});

describe("agentRuntimeContextFromTask", () => {
  it("copies checks and requiredEnv from a ready setup profile", () => {
    const ctx = agentRuntimeContextFromTask(
      task,
      {
        defaultModel: "anthropic/claude-sonnet-4-5",
      },
      readyProfile,
    );

    expect(ctx.checks).toEqual({
      test: "npm test",
      lint: "npm run lint",
    });
    expect(ctx.requiredEnv).toEqual(["API_KEY"]);
    expect(ctx.cwd).toBe("/workspaces/task-1/web");
    expect(ctx.repo).toBe("acme/web");
    expect(ctx.baseBranch).toBe("main");
  });

  it("throws when the setup profile is not ready and revision does not match", () => {
    expect(() =>
      agentRuntimeContextFromTask(
        task,
        { defaultModel: "anthropic/claude-sonnet-4-5" },
        { ...readyProfile, status: "running", revision: 99 },
      ),
    ).toThrow(/No ready setup profile/);
  });

  it("accepts the admitted revision even when the profile is updating", () => {
    const ctx = agentRuntimeContextFromTask(
      task,
      { defaultModel: "anthropic/claude-sonnet-4-5" },
      {
        ...readyProfile,
        status: "updating",
        revision: task.setupProfileRevision,
      },
    );
    expect(ctx.checks.test).toBe("npm test");
  });
});
