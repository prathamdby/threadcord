import { describe, expect, it } from "vitest";
import {
  queuePendingUserTurnMessages,
  setPendingUserTurnMessage,
  takePendingUserTurnMessages,
} from "../src/discord/user-turn-message.js";
import { World, flush } from "./support/orchestrator-harness.js";

describe("post_thread_report delivery", () => {
  it("queues one part as a single pending entry", () => {
    queuePendingUserTurnMessages("discord:thread:parts-1", ["Only part"]);
    expect(takePendingUserTurnMessages("discord:thread:parts-1")).toEqual([
      "Only part",
    ]);
  });

  it("queues six parts as six pending entries", () => {
    const parts = Array.from({ length: 6 }, (_, index) => `Part ${index + 1}`);
    queuePendingUserTurnMessages("discord:thread:parts-6", parts);
    expect(takePendingUserTurnMessages("discord:thread:parts-6")).toEqual(
      parts,
    );
  });

  it("rejects mixing post_thread_message and post_thread_report", () => {
    setPendingUserTurnMessage("discord:thread:mix", "Short summary");
    expect(() =>
      queuePendingUserTurnMessages("discord:thread:mix", ["Report body"]),
    ).toThrow(/already has a queued report/i);
  });

  it("posts queued parts in order without the turn-completed notice", async () => {
    const world = new World();
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitRaw("m-report-order");
    const task = result.task!;

    queuePendingUserTurnMessages(task.agentInstanceId, [
      "## Root cause\nThe redirect occurs because token is checked before set.",
      "## Evidence\nConsole log shows token=null at redirect time.",
    ]);
    await world.orchestrator.handleAgentEnd(task.agentInstanceId);
    await flush();

    expect(posts.filter((post) => post.startsWith("##"))).toEqual([
      "## Root cause\nThe redirect occurs because token is checked before set.",
      "## Evidence\nConsole log shows token=null at redirect time.",
    ]);
    expect(posts).not.toContain(
      "Turn completed. Waiting for the next instruction.",
    );
  });

  it("clears queued parts on failure without posting them", async () => {
    const world = new World();
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitRaw("m-report-fail");
    const task = result.task!;

    queuePendingUserTurnMessages(task.agentInstanceId, ["Should not post"]);
    await world.orchestrator.handleAgentFailure(
      task.agentInstanceId,
      "Tool validation failed",
    );
    await flush();

    expect(posts.some((post) => post.includes("Should not post"))).toBe(false);
    expect(takePendingUserTurnMessages(task.agentInstanceId)).toEqual([]);
  });

  it("passes each queued part through without clamp truncation markers", async () => {
    const world = new World();
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitRaw("m-report-length");
    const task = result.task!;
    const part = "## Summary\n" + "x".repeat(1800);

    queuePendingUserTurnMessages(task.agentInstanceId, [part]);
    await world.orchestrator.handleAgentEnd(task.agentInstanceId);
    await flush();

    const reportPost = posts.find((post) => post.length > 1000);
    expect(reportPost).toBe(part);
    expect(reportPost).not.toContain("...[truncated");
  });
});

