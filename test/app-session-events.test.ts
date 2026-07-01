import { describe, expect, it } from "vitest";
import {
  DurableConversationLog,
  FakeAgentTurn,
  TurnRunner,
  InMemoryAgentTurnPersistence,
  createDurableAgentTurn,
  type AgentTurnInput,
} from "../src/agentturn/index.js";
import type { AgentOsSessionEvent } from "../src/discord/session-event-bridge.js";
import { InMemoryConversationLogStore } from "./support/conversation-log-store.js";
import { InMemoryTurnAttemptStore } from "./support/turn-attempt-store.js";

const baseInput: AgentTurnInput = {
  instanceId: "discord:thread:thread-1",
  role: "coding",
  instruction: "Do the work",
  model: "anthropic/claude-sonnet-4-5",
  workspacePath: "/workspaces/task-1/repo",
  repo: "acme/web",
  baseBranch: "main",
  setupProfileRevision: 2,
};

describe("session event forwarder wiring", () => {
  it("persists inner session events via durable layer and forwards to bridge", async () => {
    const inner = new FakeAgentTurn({ enableRestartNotifications: false });
    const attemptStore = new InMemoryTurnAttemptStore();
    const eventStore = new InMemoryConversationLogStore();
    const sessionStore = new InMemoryAgentTurnPersistence();
    const turnRunner = new TurnRunner(attemptStore, {
      leaseOwner: "test-worker",
      turnTimeoutMs: 60_000,
      heartbeatTimeoutMs: 120_000,
      setupInstallTimeoutMs: 30_000,
      maxAttempts: 3,
    });
    const conversationLog = new DurableConversationLog(eventStore);
    const bridgeEvents: AgentOsSessionEvent[] = [];

    const durableSessionEventForwarder = {
      forward: async (_event: AgentOsSessionEvent) => {},
    };

    const durable = createDurableAgentTurn({
      inner,
      turnRunner,
      conversationLog,
      sessionStore,
      onSessionEvent: (event) => bridgeEvents.push(event),
    });

    durableSessionEventForwarder.forward = (event) => durable.onSessionEvent(event);

    const result = await durable.prompt(baseInput);
    expect(result).toEqual({ accepted: true });

    await durableSessionEventForwarder.forward({
      type: "text_delta",
      instanceId: baseInput.instanceId,
      delta: "hello",
    });

    const transcript = await conversationLog.rebuildTranscript(baseInput.instanceId);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.event_kind).toBe("text_delta");
    expect(bridgeEvents).toHaveLength(1);
    expect(bridgeEvents[0]?.type).toBe("text_delta");
  });
});
