import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeMachineEnvironment } from "../src/agentturn/index.js";
import { World, flush, config } from "./support/orchestrator-harness.js";
import type { PrepareInput, PrepareResult } from "../src/agentturn/index.js";
import type { SetupProfile } from "../src/setup/profile.js";
import type { SetupStore } from "../src/setup/store.js";

class ThrowOnFirstPrepare extends FakeMachineEnvironment {
  private threw = false;
  async prepare(input: PrepareInput): Promise<PrepareResult> {
    if (!this.threw) {
      this.threw = true;
      throw new Error("prepare exploded");
    }
    return super.prepare(input);
  }
}

const readyProfile: SetupProfile = {
  id: "profile-1",
  repo: "acme/web",
  branch: "main",
  status: "ready",
  revision: 2,
  environment: {
    install: "true",
    start: "",
    checks: {},
    requiredEnv: [],
    requiredServices: [],
  },
  memoryMarkdown: "setup memory",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function makeNullProfileStore(): SetupStore {
  return {
    getReadyProfile: async (repo: string) => {
      if (repo === "orphan/repo") return null;
      return readyProfile;
    },
    getProfile: async () => readyProfile,
  } as unknown as SetupStore;
}

describe("runTurn reservation leak", () => {
  it("releases the reservation when prepare throws", async () => {
    const world = new World(1, 9000, {
      machineEnvironment: new ThrowOnFirstPrepare(),
    });
    const first = await world.submitRaw("m-prepare-throw");
    expect(first.task!.status).toBe("failed");

    // The leaked reservation would prevent the second task from running.
    const second = await world.submitRaw("m-prepare-throw-2");
    expect(second.task!.status).toBe("running");
    expect(world.dispatched).toContain(second.task!.agentInstanceId);
  });

  it("releases the reservation when the setup profile is missing at turn time", async () => {
    const world = new World(1, 9000, {
      setupStore: makeNullProfileStore(),
    });

    const taskId = randomUUID();
    const threadId = "thread-missing-profile";
    world.store.seedTask({
      id: taskId,
      discordMessageId: "msg-missing-init",
      discordThreadId: threadId,
      agentInstanceId: `discord:thread:${threadId}`,
      workspacePath: `/workspaces/${taskId}`,
      repo: "orphan/repo",
      branch: "main",
      model: config.defaultModel,
      instruction: "Do the work",
      status: "waiting",
      initialTurnStarted: true,
      setupProfileRevision: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await world.sendThreadMessage(taskId, "msg-missing-followup", "follow up");
    expect(world.store.snapshot(taskId).status).toBe("failed");

    // A second task with a valid profile can claim the freed slot.
    const second = await world.submitRaw("m-missing-profile-2");
    expect(second.task!.status).toBe("running");
    expect(world.dispatched).toContain(second.task!.agentInstanceId);
  });

  it("releases the reservation when AgentTurn.prompt throws", async () => {
    const world = new World(1, 9000);
    world.fakeAgentTurn.throwNext(new Error("prompt exploded"));
    const first = await world.submitRaw("m-prompt-throw");
    expect(first.task!.status).toBe("failed");

    // The leaked reservation would prevent the second task from running.
    const second = await world.submitRaw("m-prompt-throw-2");
    expect(second.task!.status).toBe("running");
    expect(world.dispatched).toContain(second.task!.agentInstanceId);
  });
});
