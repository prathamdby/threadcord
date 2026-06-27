import { ToolInputValidationError } from "@flue/runtime";
import { describe, expect, it } from "vitest";
import {
  createPostThreadMessageTool,
  createPostThreadReportTool,
} from "../src/discord/thread-message-tool.js";
import {
  queuePendingUserTurnMessages,
  setPendingUserTurnMessage,
  takePendingUserTurnMessages,
} from "../src/discord/user-turn-message.js";
import { World, flush } from "./support/orchestrator-harness.js";

const VALID_PART = "## Summary\nFixed the login redirect loop in auth.ts.";
const VALID_PART_2 = "## Evidence\nConsole log shows token=null at redirect.";

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
      "## Root cause\nThe redirect occurs because token is checked before set.",
      "## Evidence\nConsole log shows token=null at redirect time.",
    ]);
    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
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
    const part = "## Summary\n" + "x".repeat(1800);

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
      tool.execute({ parts: [VALID_PART, VALID_PART_2] }),
    ).resolves.toBe("2 report part(s) queued for Discord.");
    expect(takePendingUserTurnMessages(instanceId)).toEqual([
      VALID_PART,
      VALID_PART_2,
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
        parts: Array.from(
          { length: 7 },
          (_, index) => `## Section ${index + 1}\nContent for section.`,
        ),
      }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
  });

  it("rejects parts longer than 1900 chars", async () => {
    const tool = createPostThreadReportTool(`${instanceId}-long`);
    await expect(
      tool.execute({ parts: ["## Summary\n" + "x".repeat(1901)] }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
  });

  it("rejects thin content with ## header but no substance", async () => {
    const tool = createPostThreadReportTool(`${instanceId}-thin`);
    await expect(
      tool.execute({ parts: ["## Summary\nDone."] }),
    ).rejects.toThrow(/substantive body text/);
  });

  it("rejects content with no ## headers", async () => {
    const tool = createPostThreadReportTool(`${instanceId}-nohdr`);
    await expect(
      tool.execute({ parts: ["Fixed the bug. Tests pass."] }),
    ).rejects.toThrow(/## section header/);
  });

  it("rejects when only one part of many is thin", async () => {
    const tool = createPostThreadReportTool(`${instanceId}-mixed`);
    await expect(
      tool.execute({
        parts: [VALID_PART, "## Summary\nDone."],
      }),
    ).rejects.toThrow(/Part 2/);
  });
});

describe("post_thread_message validation", () => {
  const instanceId = "discord:thread:msg-val";

  it("accepts a concise multi-section message", async () => {
    const tool = createPostThreadMessageTool(`${instanceId}-ok`);
    await expect(
      tool.execute({
        message: [
          "## Summary",
          "Fixed the login redirect loop in auth.ts.",
          "",
          "## Verification",
          "Ran npm test — all 12 tests pass.",
        ].join("\n"),
      }),
    ).resolves.toBe("Message queued for Discord.");
  });

  it("rejects thin content with ## header but no substance", async () => {
    const tool = createPostThreadMessageTool(`${instanceId}-thin`);
    await expect(
      tool.execute({ message: "## Summary\nDone." }),
    ).rejects.toThrow(/substantive body text/);
  });

  it("rejects content with no ## headers", async () => {
    const tool = createPostThreadMessageTool(`${instanceId}-nohdr`);
    await expect(
      tool.execute({ message: "Fixed the bug. Tests pass." }),
    ).rejects.toThrow(/## section header/);
  });
});
