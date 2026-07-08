import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  renderTaskHeader,
  taskHeaderEntries,
} from "../src/discord/task-header.js";
import type { TaskRecord } from "../src/types.js";

const IS_COMPONENTS_V2 = 32768;

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
  setupProfileRevision: 2,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:01:00Z"),
};

const now = new Date("2026-01-01T00:05:00Z");
const options = { now, queue: { position: 2, depth: 4 } as const };

describe("renderTaskHeader", () => {
  it("renders a CV2 kv container without message content", () => {
    const header = renderTaskHeader(baseTask, options);
    expect(header).not.toHaveProperty("content");
    expect(header.flags & MessageFlags.IsComponentsV2).toBe(IS_COMPONENTS_V2);
    const body = JSON.stringify(header);
    expect(body).toContain("Threadcord task");
    expect(body).toContain("**State**: queued");
    expect(body).toContain("**Repo**: acme/web");
    expect(body).toContain("**Queue**: position 2 of 4");
  });

  it("renders queue position in entries", () => {
    const entries = taskHeaderEntries(baseTask, options);
    expect(entries).toContainEqual(["Queue", "position 2 of 4"]);
  });

  it("renders running turns", () => {
    const entries = taskHeaderEntries(
      { ...baseTask, status: "running" },
      { now, runningTurn: "follow-up" },
    );
    expect(entries).toContainEqual(["Turn", "follow-up"]);
  });

  it("renders waiting as ready for a follow-up", () => {
    const entries = taskHeaderEntries(
      { ...baseTask, status: "waiting" },
      { now },
    );
    expect(entries).toContainEqual(["State", "ready for a follow-up"]);
  });

  it("renders failed summaries on one line", () => {
    const entries = taskHeaderEntries(
      {
        ...baseTask,
        status: "failed",
        errorSummary: "first line\nsecond line",
      },
      { now },
    );
    expect(entries).toContainEqual(["Failure", "first line second line"]);
  });

  it("renders terminal outcome states", () => {
    const cancelled = taskHeaderEntries(
      { ...baseTask, status: "cancelled" },
      { now },
    );
    const completed = taskHeaderEntries(
      { ...baseTask, status: "completed" },
      { now },
    );

    expect(cancelled).toContainEqual(["State", "cancelled, no further turns"]);
    expect(cancelled).toContainEqual(["Outcome", "no further turns will run."]);
    expect(completed).toContainEqual(["State", "completed"]);
    expect(completed).toContainEqual(["Outcome", "closed by user."]);
  });
});
