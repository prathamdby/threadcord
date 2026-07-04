import { describe, expect, it } from "vitest";
import { formatTaskInstructionForDiscord } from "../src/discord/task-instruction-message.js";
import { World } from "./support/orchestrator-harness.js";

const taskFields = ["repo: acme/web", "branch: main"].join("\n");

describe("control channel message task creation", () => {
  it("creates a task from a keyed control-channel message", async () => {
    const world = new World();
    const result = await world.submitChannelMessage(
      "m-channel",
      ["Fix the auth test.", "", taskFields].join("\n"),
    );

    expect(result.threadsCreated).toBe(1);
    expect(result.task?.status).toBe("running");
    expect(result.task?.instruction).toContain("Fix the auth test.");
    expect(result.sends).toContain(
      formatTaskInstructionForDiscord("Fix the auth test."),
    );
    expect(result.message.reactCalls).toContain("👀");
  });

  it("ignores messages outside the configured control channel", async () => {
    const world = new World();
    const result = await world.submitChannelMessage(
      "m-other-channel",
      ["Fix the auth test.", "", taskFields].join("\n"),
      { channelId: "other-channel" },
    );

    expect(result.threadsCreated).toBe(0);
    expect(result.task).toBeUndefined();
    expect(result.replies).toHaveLength(0);
  });

  it("rejects invalid message format with a reply", async () => {
    const world = new World();
    const result = await world.submitChannelMessage("m-bad", "just prose");

    expect(result.threadsCreated).toBe(0);
    expect(result.replies[0]).toMatch(/^Rejected:/);
  });

  it("includes attachments in the stored instruction for the model", async () => {
    const dispatched: { instruction: string }[] = [];
    const world = new World(1, 9000, {
      dispatch: async (_instanceId, input) => {
        dispatched.push({ instruction: input.instruction });
      },
    });

    const result = await world.submitChannelMessage(
      "m-attach",
      ["Review this screenshot.", "", taskFields].join("\n"),
      {
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/1/2/mock.png",
            name: "mock.png",
            contentType: "image/png",
            width: 640,
            height: 480,
          },
        ],
      },
    );

    expect(result.task?.status).toBe("running");
    expect(result.task?.instruction).toContain("Attached image: mock.png");
    expect(result.task?.instruction).toContain("mock.png");
    expect(dispatched[0]?.instruction).toContain("Attached image: mock.png");
  });

  it("accepts attachment-only messages when repo and branch are present", async () => {
    const world = new World();
    const result = await world.submitChannelMessage("m-attach-only", taskFields, {
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/1/2/spec.pdf",
          name: "spec.pdf",
          contentType: "application/pdf",
          width: null,
          height: null,
        },
      ],
    });

    expect(result.threadsCreated).toBe(1);
    expect(result.task?.instruction).toContain("Attached file: spec.pdf");
    expect(result.sends.some((line) => line.includes("Attached file"))).toBe(
      true,
    );
  });

  it("reports thread creation failures via reply", async () => {
    const world = new World();
    const result = await world.submitChannelMessage(
      "m-thread-fail",
      ["Fix it.", "", taskFields].join("\n"),
      { failure: { createThread: true } },
    );

    expect(result.task?.status).toBe("failed");
    expect(result.replies[0]).toContain("Could not create a thread");
  });
});

describe("control channel duplicate messages", () => {
  it("does not create a second task for the same message id", async () => {
    const world = new World();
    const first = await world.submitChannelMessage(
      "m-dup",
      ["Fix it.", "", taskFields].join("\n"),
    );
    const second = await world.submitChannelMessage(
      "m-dup",
      ["Fix it.", "", taskFields].join("\n"),
    );

    expect(first.threadsCreated).toBe(1);
    expect(second.threadsCreated).toBe(0);
    expect(world.store.taskCount()).toBe(1);
  });
});
