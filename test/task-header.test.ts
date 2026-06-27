import { describe, expect, it } from "vitest";
import { renderTaskHeader } from "../src/discord/task-header.js";
import type { TaskRecord } from "../src/types.js";

const baseTask: TaskRecord = {
  id: "task-1",
  discordMessageId: "message-1",
  discordThreadId: "thread-1",
  flueInstanceId: "discord:thread:thread-1",
  workspacePath: "/workspaces/task-1",
  repo: "acme/web",
  branch: "main",
  model: "anthropic/claude-sonnet-4-5",
  instruction: "Do the work",
  status: "queued",
  initialTurnStarted: false,
  setupProfileRevision: 2,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:01:00Z"),
};

const now = new Date("2026-01-01T00:05:00Z");

describe("renderTaskHeader", () => {
  it("renders queued position and task identity", () => {
    const header = renderTaskHeader(baseTask, {
      now,
      queue: { position: 2, depth: 4 },
    });

    expect(header).toContain("State: queued");
    expect(header).toContain("Repo: acme/web");
    expect(header).toContain("Branch: main");
    expect(header).toContain("Model: anthropic/claude-sonnet-4-5");
    expect(header).toContain("Queue: position 2 of 4");
    expect(header).toContain("Elapsed: 5m");
    expect(header).toContain("Last update: 4m ago");
  });

  it("renders running turns", () => {
    const header = renderTaskHeader(
      { ...baseTask, status: "running", initialTurnStarted: true },
      { now, runningTurn: "follow-up" },
    );

    expect(header).toContain("State: running");
    expect(header).toContain("Turn: follow-up");
  });

  it("renders waiting as ready for a follow-up", () => {
    const header = renderTaskHeader(
      { ...baseTask, status: "waiting", initialTurnStarted: true },
      { now },
    );

    expect(header).toContain("State: ready for a follow-up");
  });

  it("renders failed summaries on one line", () => {
    const header = renderTaskHeader(
      {
        ...baseTask,
        status: "failed",
        errorSummary: "first line\nsecond line",
      },
      { now },
    );

    expect(header).toContain("State: failed");
    expect(header).toContain("Failure: first line second line");
    expect(header).toContain("Next: fix the cause and send a new message in this thread.");
  });

  it("renders terminal outcome states", () => {
    const cancelled = renderTaskHeader(
      { ...baseTask, status: "cancelled" },
      { now },
    );
    const completed = renderTaskHeader(
      { ...baseTask, status: "completed" },
      { now },
    );

    expect(cancelled).toContain("State: cancelled, no further turns");
    expect(cancelled).toContain("Outcome: no further turns will run.");
    expect(completed).toContain("State: completed");
    expect(completed).toContain("Outcome: closed by user.");
  });
});
