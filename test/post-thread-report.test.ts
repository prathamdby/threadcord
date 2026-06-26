import { ToolInputValidationError } from "@flue/runtime";
import { describe, expect, it } from "vitest";
import { createPostThreadReportTool } from "../src/discord/thread-message-tool.js";
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

    queuePendingUserTurnMessages(task.flueInstanceId, [
      "## Root cause",
      "## Evidence",
    ]);
    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    expect(posts.filter((post) => post.startsWith("##"))).toEqual([
      "## Root cause",
      "## Evidence",
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

    queuePendingUserTurnMessages(task.flueInstanceId, ["Should not post"]);
    await world.orchestrator.handleAgentFailure(
      task.flueInstanceId,
      "Tool validation failed",
    );
    await flush();

    expect(posts.some((post) => post.includes("Should not post"))).toBe(false);
    expect(takePendingUserTurnMessages(task.flueInstanceId)).toEqual([]);
  });

  it("passes each queued part through without clamp truncation markers", async () => {
    const world = new World();
    const posts: string[] = [];
    world.orchestrator.setMilestonePublisher(async (_threadId, content) => {
      posts.push(content);
    });
    const result = await world.submitRaw("m-report-length");
    const task = result.task!;
    const part = "x".repeat(1800);

    queuePendingUserTurnMessages(task.flueInstanceId, [part]);
    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    const reportPost = posts.find((post) => post.length > 1000);
    expect(reportPost).toBe(part);
    expect(reportPost).not.toContain("...[truncated");
  });
});

describe("post_thread_report tool validation", () => {
  const instanceId = "discord:thread:tool-validation";

  it("queues valid parts through the tool execute path", async () => {
    const tool = createPostThreadReportTool(instanceId);
    await expect(
      tool.execute({ parts: ["Part one", "Part two"] }),
    ).resolves.toBe("2 report part(s) queued for Discord.");
    expect(takePendingUserTurnMessages(instanceId)).toEqual([
      "Part one",
      "Part two",
    ]);
  });

  it("rejects empty parts arrays", async () => {
    const tool = createPostThreadReportTool(`${instanceId}-empty`);
    await expect(tool.execute({ parts: [] })).rejects.toBeInstanceOf(
      ToolInputValidationError,
    );
  });

  it("rejects more than six parts", async () => {
    const tool = createPostThreadReportTool(`${instanceId}-max`);
    await expect(
      tool.execute({
        parts: Array.from({ length: 7 }, (_, index) => `Part ${index + 1}`),
      }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
  });

  it("rejects parts longer than 1900 chars", async () => {
    const tool = createPostThreadReportTool(`${instanceId}-long`);
    await expect(
      tool.execute({ parts: ["x".repeat(1901)] }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
  });
});
