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

function recordingBridge(): {
  callbacks: ObserveBridgeCallbacks;
  edits: string[];
  state: NonNullable<Parameters<typeof handleObserveEvent>[2]>;
} {
  const edits: string[] = [];
  const callbacks = {
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
      edit: async (_threadId: string, _messageId: string, content: string) => {
        edits.push(content);
      },
      send: async () => ({ id: "m1" }),
    },
    onAgentEnd: async () => {},
    onAgentFailure: async () => {},
  } as unknown as ObserveBridgeCallbacks;
  const state = {
    renderState: new Map(),
    timers: new Map(),
    instanceChains: new Map<string, Promise<void>>(),
  };
  return { callbacks, edits, state };
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
      renderState: new Map(),
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

  it("renders read_file with a quoted path preview", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "read_file",
        toolCallId: "tc-1",
        args: { path: "src/main.py" },
        instanceId: toFlueInstanceId("thread-1"),
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits[0]).toContain('📖 read_file: "src/main.py"');
    vi.useRealTimers();
  });

  it("renders bash as a fenced code block with a 💻 bash header", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "bash",
        toolCallId: "tc-1",
        args: { command: "pytest -q" },
        instanceId: toFlueInstanceId("thread-1"),
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits[0]).toBe("💻 bash\n```\npytest -q\n```");
    vi.useRealTimers();
  });

  it("omits the 💻 bash header on a consecutive different bash command", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "bash",
        toolCallId: "tc-1",
        args: { command: "echo one" },
        instanceId,
      }),
      callbacks,
      state,
    );
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "bash",
        toolCallId: "tc-2",
        args: { command: "echo two" },
        instanceId,
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits[0]).toBe("💻 bash\n```\necho one\n```\n```\necho two\n```");
    vi.useRealTimers();
  });

  it("collapses consecutive identical bash calls to a (×N) counter", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    for (let i = 0; i < 3; i += 1) {
      await handleObserveEvent(
        taskEvent({
          type: "tool_start",
          toolName: "bash",
          toolCallId: `tc-${i}`,
          args: { command: "pytest -q" },
          instanceId,
        }),
        callbacks,
        state,
      );
    }
    await vi.runAllTimersAsync();
    expect(edits[0]).toContain("💻 bash");
    expect(edits[0]).toContain("(×3)");
    vi.useRealTimers();
  });

  it("collapses consecutive identical non-bash tool calls to a (×N) counter", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    for (let i = 0; i < 2; i += 1) {
      await handleObserveEvent(
        taskEvent({
          type: "tool_start",
          toolName: "read_file",
          toolCallId: `tc-${i}`,
          args: { path: "src/main.py" },
          instanceId,
        }),
        callbacks,
        state,
      );
    }
    await vi.runAllTimersAsync();
    expect(edits[0]).toBe('📖 read_file: "src/main.py" (×2)');
    vi.useRealTimers();
  });

  it("renders an unknown tool with no string args as a default line", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "mcp_unknown_tool",
        toolCallId: "tc-1",
        args: { enabled: true, count: 7 },
        instanceId: toFlueInstanceId("thread-1"),
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits[0]).toContain("⚙️ mcp_unknown_tool…");
    vi.useRealTimers();
  });

  it("adds no line for a tool finished event", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "read_file",
        toolCallId: "tc-1",
        args: { path: "src/main.py" },
        instanceId,
      }),
      callbacks,
      state,
    );
    await handleObserveEvent(
      taskEvent({
        type: "tool",
        toolName: "read_file",
        toolCallId: "tc-1",
        isError: false,
        durationMs: 5,
        instanceId,
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('📖 read_file: "src/main.py"');
    expect(edits[0]).not.toContain("finished");
    vi.useRealTimers();
  });

  it("truncates a preview longer than 40 chars with ... inside the quotes", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "read_file",
        toolCallId: "tc-1",
        args: { path: "x".repeat(50) },
        instanceId: toFlueInstanceId("thread-1"),
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits[0]).toBe(`📖 read_file: "${"x".repeat(37)}..."`);
    vi.useRealTimers();
  });

  it("redacts secrets in tool arg previews", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const secret = "ghp_aBcDeFgHiJkLmNoPqRsTuvw";
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "read_file",
        toolCallId: "tc-1",
        args: { path: secret },
        instanceId: toFlueInstanceId("thread-1"),
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits[0]).toContain("[redacted]");
    expect(edits[0]).not.toContain(secret);
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
