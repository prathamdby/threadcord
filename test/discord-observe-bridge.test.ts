import { describe, expect, it, vi } from "vitest";
import type { FlueEvent } from "@flue/runtime";
import { toFlueInstanceId } from "../src/ids.js";
import {
  failureDiscordMessage,
  handleObserveEvent,
  submissionFailureSummary,
  type ObserveBridgeCallbacks,
} from "../src/discord/observe-bridge.js";
import { InMemoryStore } from "./support/orchestrator-harness.js";
import { TaskOrchestrator } from "../src/task/orchestrator.js";
import {
  config,
  fakeSetupStore,
} from "./support/orchestrator-harness.js";

function taskEvent(partial: Record<string, unknown>): FlueEvent {
  return {
    v: 1,
    eventIndex: 1,
    timestamp: "2026-06-25T00:00:00.000Z",
    ...partial,
  } as FlueEvent;
}

describe("submissionFailureSummary", () => {
  it("detects submission_settled failures", () => {
    expect(
      submissionFailureSummary(
        taskEvent({
          type: "submission_settled",
          submissionId: "submission-1",
          outcome: "failed",
          error: "Stream ended without finish_reason",
          instanceId: toFlueInstanceId("thread-1"),
        }),
      ),
    ).toBe("Stream ended without finish_reason");
  });

  it("detects turn failures", () => {
    expect(
      submissionFailureSummary(
        taskEvent({
          type: "turn",
          turnId: "turn-1",
          purpose: "agent",
          durationMs: 12,
          isError: true,
          error: "Stream ended without finish_reason",
          instanceId: toFlueInstanceId("thread-1"),
        }),
      ),
    ).toBe("Stream ended without finish_reason");
  });
});

describe("failureDiscordMessage", () => {
  it("names provider stream cutoffs explicitly", () => {
    expect(
      failureDiscordMessage("Stream ended without finish_reason"),
    ).toContain("stream ended before completion");
  });
});

describe("handleObserveEvent", () => {
  it("calls onAgentFailure for failed turn events", async () => {
    const onAgentFailure = vi.fn(async () => {});
    await handleObserveEvent(
      taskEvent({
        type: "turn",
        turnId: "turn-1",
        purpose: "agent",
        durationMs: 12,
        isError: true,
        error: "Stream ended without finish_reason",
        instanceId: toFlueInstanceId("thread-1"),
      }),
      {
        store: { getByInstanceId: async () => undefined },
        publisher: {
          edit: async () => {},
          send: async () => ({ id: "m1" }),
        },
        onAgentEnd: async () => {},
        onAgentFailure,
      } as unknown as ObserveBridgeCallbacks,
    );

    expect(onAgentFailure).toHaveBeenCalledWith(
      toFlueInstanceId("thread-1"),
      "Stream ended without finish_reason",
    );
  });

  it("buffers turn_start status lines", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    await handleObserveEvent(
      taskEvent({
        type: "turn_start",
        turnId: "turn-1",
        purpose: "agent",
        instanceId: toFlueInstanceId("thread-1"),
      }),
      {
        store: {
          getByInstanceId: async () => ({
            id: "task-1",
            discordMessageId: "msg-1",
            discordThreadId: "thread-1",
            flueInstanceId: toFlueInstanceId("thread-1"),
            workspacePath: "/workspaces/task-1",
            repo: "acme/web",
            branch: "main",
            model: "anthropic/claude-sonnet-4-5",
            instruction: "Do the work",
            setupProfileRevision: 2,
            status: "running",
            initialTurnStarted: true,
            statusMessageId: "status-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          }),
        },
        publisher: {
          edit: async (
            _threadId: string,
            _messageId: string,
            content: string,
          ) => {
            edits.push(content);
          },
          send: async () => ({ id: "m1" }),
        },
        onAgentEnd: async () => {},
        onAgentFailure: async () => {},
      } as unknown as ObserveBridgeCallbacks,
    );

    await vi.runAllTimersAsync();
    expect(edits[0]).toContain("Model turn started");
    vi.useRealTimers();
  });
});

describe("TaskOrchestrator.handleAgentFailure", () => {
  it("marks a running task failed and keeps it failed on agent_end", async () => {
    const store = new InMemoryStore(1);
    const orchestrator = new TaskOrchestrator(
      config,
      store as never,
      fakeSetupStore,
    );
    const { task, created } = await store.createDraft({
      id: "task-1",
      discordMessageId: "msg-1",
      discordThreadId: toFlueInstanceId("thread-1"),
      flueInstanceId: toFlueInstanceId("thread-1"),
      workspacePath: "/workspaces/task-1",
      repo: "acme/web",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      instruction: "Do the work",
      setupProfileRevision: 2,
    });
    expect(created).toBe(true);
    await store.attachAndPromote(
      task.id,
      "thread-1",
      toFlueInstanceId("thread-1"),
      "status-1",
    );
    await store.claimNextTurn(task.id);

    await orchestrator.handleAgentFailure(
      toFlueInstanceId("thread-1"),
      "Stream ended without finish_reason",
    );
    expect(store.snapshot(task.id).status).toBe("failed");

    await orchestrator.handleAgentEnd(toFlueInstanceId("thread-1"));
    expect(store.snapshot(task.id).status).toBe("failed");
  });
});
