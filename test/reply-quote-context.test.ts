import { describe, expect, it } from "vitest";
import { World, flush } from "./support/orchestrator-harness.js";

describe("follow-up reply quote context", () => {
  it("includes the quoted message in the dispatched agent instruction", async () => {
    const dispatched: { instruction: string }[] = [];
    const world = new World(1, 9000, {
      dispatch: async (_instanceId, input) => {
        dispatched.push({ instruction: input.instruction });
      },
    });

    const result = await world.submitRaw("m-reply-quote");
    const task = result.task!;

    // Initial turn is dispatched synchronously after submitRaw flushes.
    expect(task.status).toBe("running");
    dispatched.length = 0;

    // End the initial turn so the task accepts follow-ups.
    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();
    expect(world.store.snapshot(task.id).status).toBe("waiting");

    await world.submitFollowup(
      task.id,
      "m-followup",
      "fix the lint error it reported",
      { content: "eslint: 'x' is not defined (no-undef)", authorBot: true },
    );

    expect(dispatched).toHaveLength(1);
    const instruction = dispatched[0]!.instruction;
    expect(instruction).toContain("The user replied to the bot's earlier message:");
    expect(instruction).toContain("> eslint: 'x' is not defined (no-undef)");
    expect(instruction).toContain("fix the lint error it reported");
  });

  it("phrases user-authored quotes generically", async () => {
    const dispatched: { instruction: string }[] = [];
    const world = new World(1, 9000, {
      dispatch: async (_instanceId, input) => {
        dispatched.push({ instruction: input.instruction });
      },
    });

    const result = await world.submitRaw("m-reply-quote-2");
    const task = result.task!;
    dispatched.length = 0;

    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    await world.submitFollowup(
      task.id,
      "m-followup-2",
      "yes, do that",
      { content: "Can you also add a test for it?", authorBot: false },
    );

    expect(dispatched).toHaveLength(1);
    const instruction = dispatched[0]!.instruction;
    expect(instruction).toContain("The user replied to this earlier message in the thread:");
    expect(instruction).toContain("> Can you also add a test for it?");
    expect(instruction).toContain("yes, do that");
  });

  it("does not include a reply block for plain follow-ups", async () => {
    const dispatched: { instruction: string }[] = [];
    const world = new World(1, 9000, {
      dispatch: async (_instanceId, input) => {
        dispatched.push({ instruction: input.instruction });
      },
    });

    const result = await world.submitRaw("m-reply-quote-3");
    const task = result.task!;
    dispatched.length = 0;

    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    await world.submitFollowup(task.id, "m-followup-3", "just fix it");

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.instruction).not.toContain("replied to");
    expect(dispatched[0]!.instruction).toContain("just fix it");
  });

  it("rejects a follow-up that is only a reply quote with no text", async () => {
    const dispatched: { instruction: string }[] = [];
    const world = new World(1, 9000, {
      dispatch: async (_instanceId, input) => {
        dispatched.push({ instruction: input.instruction });
      },
    });

    const result = await world.submitRaw("m-reply-quote-4");
    const task = result.task!;
    dispatched.length = 0;

    await world.orchestrator.handleAgentEnd(task.flueInstanceId);
    await flush();

    const { replies } = await world.submitFollowup(
      task.id,
      "m-followup-4",
      "   ",
      { content: "some earlier message", authorBot: false },
    );

    expect(replies).toContain(
      "Cannot queue an empty instruction. Please include some text or an attachment.",
    );
    expect(dispatched).toHaveLength(0);
  });
});
