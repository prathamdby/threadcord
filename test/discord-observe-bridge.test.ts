import { describe, expect, it, vi } from "vitest";
import type { FlueEvent } from "@flue/runtime";
import { toFlueInstanceId } from "../src/ids.js";
import {
  failureDiscordMessage,
  handleObserveEvent,
  submissionFailureSummary,
  withInstanceEventLock,
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

  it("detects submission_settled failures when error is an Error object", () => {
    expect(
      submissionFailureSummary(
        taskEvent({
          type: "submission_settled",
          submissionId: "submission-1",
          outcome: "failed",
          error: new Error("Stream ended without finish_reason"),
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

  it("serializes failure handling before agent_end for the same instance", async () => {
    const order: string[] = [];
    const instanceId = toFlueInstanceId("thread-1");
    const sharedState = {
      buffers: new Map(),
      timers: new Map(),
      instanceChains: new Map<string, Promise<void>>(),
    };
    const callbacks = {
      store: { getByInstanceId: async () => undefined },
      publisher: {
        edit: async () => {},
        send: async () => ({ id: "m1" }),
      },
      onAgentFailure: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        order.push("failure");
      },
      onAgentEnd: async () => {
        order.push("end");
      },
    } as unknown as ObserveBridgeCallbacks;

    await Promise.all([
      withInstanceEventLock(
        taskEvent({
          type: "turn",
          turnId: "turn-1",
          purpose: "agent",
          durationMs: 12,
          isError: true,
          error: "Stream ended without finish_reason",
          instanceId,
        }),
        sharedState,
        () =>
          handleObserveEvent(
            taskEvent({
              type: "turn",
              turnId: "turn-1",
              purpose: "agent",
              durationMs: 12,
              isError: true,
              error: "Stream ended without finish_reason",
              instanceId,
            }),
            callbacks,
            sharedState,
          ),
      ),
      withInstanceEventLock(
        taskEvent({
          type: "agent_end",
          messages: [],
          instanceId,
        }),
        sharedState,
        () =>
          handleObserveEvent(
            taskEvent({
              type: "agent_end",
              messages: [],
              instanceId,
            }),
            callbacks,
            sharedState,
          ),
      ),
    ]);

    expect(order).toEqual(["failure", "end"]);
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
