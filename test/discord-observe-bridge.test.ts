import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlueEvent } from "@flue/runtime";
import { cacheConfig } from "../src/config.js";
import { toFlueInstanceId } from "../src/ids.js";
import {
  failureDiscordMessage,
  handleObserveEvent,
  shouldRollBubble,
  submissionFailureSummary,
  withInstanceEventLock,
  type ObserveBridgeCallbacks,
} from "../src/discord/observe-bridge.js";
import {
  PROGRESS_ROLL_THRESHOLD,
  clampDiscordContent,
} from "../src/discord/limits.js";
import { formatToolLine } from "../src/discord/tool-format.js";
import { redact } from "../src/util/redact.js";
import { progressMessageIdsFromRow } from "../src/task/store.js";
import { InMemoryStore } from "./support/orchestrator-harness.js";
import { TaskOrchestrator } from "../src/task/orchestrator.js";
import { config, fakeSetupStore } from "./support/orchestrator-harness.js";

beforeEach(() => {
  cacheConfig(config);
});

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
  sends: { id: string; content: string }[];
  state: NonNullable<Parameters<typeof handleObserveEvent>[2]>;
} {
  const edits: string[] = [];
  const sends: { id: string; content: string }[] = [];
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
        progressMessageIds: ["status-1"],
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      appendProgressMessageId: async () => undefined,
    },
    publisher: {
      edit: async (_threadId: string, _messageId: string, content: string) => {
        edits.push(content);
      },
      send: async (_threadId: string, content: string) => {
        const id = `status-${sends.length + 2}`;
        sends.push({ id, content });
        return { id };
      },
    },
    onAgentEnd: async () => {},
    onAgentFailure: async () => {},
  } as unknown as ObserveBridgeCallbacks;
  const state = {
    renderState: new Map(),
    timers: new Map(),
    instanceChains: new Map<string, Promise<void>>(),
  };
  return { callbacks, edits, sends, state };
}

function toolStartEvent(
  toolName: string,
  args: Record<string, unknown>,
  instanceId: string,
): FlueEvent {
  return taskEvent({
    type: "tool_start",
    toolName,
    toolCallId: "tc",
    args,
    instanceId,
  });
}

function bashEvent(command: string, instanceId: string): FlueEvent {
  return toolStartEvent("bash", { command }, instanceId);
}

function readFileEvent(path: string, instanceId: string): FlueEvent {
  return toolStartEvent("read_file", { path }, instanceId);
}

function longToolEvent(toolName: string, instanceId: string): FlueEvent {
  return toolStartEvent(toolName, { count: 7 }, instanceId);
}

function fillerPath(i: number): string {
  return `p${i}` + "x".repeat(50);
}

async function rollingWorld(): Promise<{
  callbacks: ObserveBridgeCallbacks;
  sent: { id: string; content: string }[];
  edits: { messageId: string; content: string }[];
  state: NonNullable<Parameters<typeof handleObserveEvent>[2]>;
  instanceId: string;
  store: InMemoryStore;
}> {
  const store = new InMemoryStore(1);
  const instanceId = toFlueInstanceId("thread-1");
  await store.createDraft({
    id: "task-1",
    discordMessageId: "msg-1",
    discordThreadId: "pending:task-1",
    flueInstanceId: "pending:task-1",
    workspacePath: "/workspaces/task-1",
    repo: "acme/web",
    branch: "main",
    model: "anthropic/claude-sonnet-4-5",
    instruction: "Do the work",
    setupProfileRevision: 2,
  });
  await store.attachAndPromote("task-1", "thread-1", instanceId, "status-1");
  const sent: { id: string; content: string }[] = [];
  const edits: { messageId: string; content: string }[] = [];
  let sendSeq = 2;
  const callbacks = {
    store,
    publisher: {
      edit: async (_threadId: string, messageId: string, content: string) => {
        edits.push({
          messageId,
          content: clampDiscordContent(redact(content)),
        });
      },
      send: async (_threadId: string, content: string) => {
        const id = `status-${sendSeq++}`;
        sent.push({ id, content: clampDiscordContent(redact(content)) });
        return { id };
      },
    },
    onAgentEnd: async () => {},
    onAgentFailure: async () => {},
  } as unknown as ObserveBridgeCallbacks;
  const state = {
    renderState: new Map(),
    timers: new Map(),
    instanceChains: new Map<string, Promise<void>>(),
  };
  return { callbacks, sent, edits, state, instanceId, store };
}

function linesThatFit(line: string): number {
  return Math.floor((PROGRESS_ROLL_THRESHOLD + 1) / (line.length + 1));
}

describe("shouldRollBubble", () => {
  it("never rolls an empty bubble", () => {
    expect(shouldRollBubble(0, 2000)).toBe(false);
  });

  it("rolls when the next line would cross the threshold", () => {
    expect(shouldRollBubble(1900, 100)).toBe(true);
  });

  it("does not roll when the next line still fits", () => {
    expect(shouldRollBubble(1800, 100)).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(shouldRollBubble(900, 100, 1000)).toBe(true);
    expect(shouldRollBubble(800, 100, 1000)).toBe(false);
  });
});

describe("progressMessageIdsFromRow", () => {
  it("prefers the progress_message_ids column", () => {
    expect(
      progressMessageIdsFromRow({ progress_message_ids: ["a", "b"] }),
    ).toEqual({ progressMessageIds: ["a", "b"] });
  });

  it("synthesizes from a legacy status_message_id", () => {
    expect(progressMessageIdsFromRow({ status_message_id: "old" })).toEqual({
      progressMessageIds: ["old"],
      statusMessageId: "old",
    });
  });

  it("returns nothing for an unattached draft", () => {
    expect(progressMessageIdsFromRow({})).toEqual({});
  });
});

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
  it("returns a generic message for provider stream cutoffs", () => {
    const message = failureDiscordMessage(
      "Stream ended without finish_reason",
    );
    expect(message).toContain("encountered an error");
    expect(message).not.toContain("stream ended before completion");
    expect(message).not.toContain("finish_reason");
  });

  it("returns a generic message for tool failure guard stops", () => {
    const message = failureDiscordMessage(
      "Stopped after 10 consecutive tool failures (last: edit: bad args).",
    );
    expect(message).toContain("encountered an error");
    expect(message).not.toContain("retry loop");
    expect(message).not.toContain("consecutive tool failures");
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
      withInstanceEventLock(instanceId, sharedState, () =>
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
      withInstanceEventLock(instanceId, sharedState, () =>
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
            progressMessageIds: ["status-1"],
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

  it("keeps the bash header suppressed when a later identical call dedups", async () => {
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
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "bash",
        toolCallId: "tc-3",
        args: { command: "echo two" },
        instanceId,
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits[0]).toBe(
      "💻 bash\n```\necho one\n```\n```\necho two\n``` (×2)",
    );
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

  it("surfaces tool validation failures as tool_failed lines", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    await handleObserveEvent(
      taskEvent({
        type: "tool_start",
        toolName: "post_thread_message",
        toolCallId: "tc-err",
        args: { message: "x".repeat(2000) },
        instanceId,
      }),
      callbacks,
      state,
    );
    await handleObserveEvent(
      taskEvent({
        type: "tool",
        toolName: "post_thread_message",
        toolCallId: "tc-err",
        isError: true,
        result: "message exceeds 1900 chars; use post_thread_report",
        durationMs: 2,
        instanceId,
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(
      edits.some((line) => line.includes("tool_failed: post_thread_message")),
    ).toBe(true);
    expect(edits.some((line) => line.includes("1900 chars"))).toBe(false);
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

describe("tool error formatting (Flue content-array shapes)", () => {
  it("surfaces content-array text and exit-code details for a bash failure", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    await handleObserveEvent(
      taskEvent({
        type: "tool",
        toolName: "bash",
        toolCallId: "tc-err",
        isError: true,
        result: {
          content: [{ type: "text", text: "bash: npm: command not found" }],
          details: { command: "npm test", exitCode: 127 },
        },
        durationMs: 3,
        instanceId,
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("tool_failed: bash");
    expect(edits[0]).not.toContain("bash: npm: command not found");
    expect(edits[0]).not.toContain("npm test exited with code 127");
    vi.useRealTimers();
  });

  it("surfaces text from a minimal content-array block with no type field", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    await handleObserveEvent(
      taskEvent({
        type: "tool",
        toolName: "edit",
        toolCallId: "tc-err",
        isError: true,
        result: { content: [{ text: "oldText not found" }] },
        durationMs: 1,
        instanceId,
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("tool_failed: edit");
    expect(edits[0]).not.toContain("oldText not found");
    vi.useRealTimers();
  });

  it("still surfaces a plain Error result message", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    await handleObserveEvent(
      taskEvent({
        type: "tool",
        toolName: "custom_tool",
        toolCallId: "tc-err",
        isError: true,
        result: new Error("custom tool blew up"),
        durationMs: 1,
        instanceId,
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("tool_failed: custom_tool");
    expect(edits[0]).not.toContain("custom tool blew up");
    vi.useRealTimers();
  });

  it("redacts secrets inside content-array error text", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    const secret = "ghp_aBcDeFgHiJkLmNoPqRsTuvw";
    await handleObserveEvent(
      taskEvent({
        type: "tool",
        toolName: "bash",
        toolCallId: "tc-err",
        isError: true,
        result: {
          content: [{ type: "text", text: `auth failed for ${secret}` }],
        },
        durationMs: 1,
        instanceId,
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("tool_failed: bash");
    expect(edits[0]).not.toContain("[redacted]");
    expect(edits[0]).not.toContain(secret);
    vi.useRealTimers();
  });

  it("rejects array details and non-integer exit codes", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const instanceId = toFlueInstanceId("thread-1");
    await handleObserveEvent(
      taskEvent({
        type: "tool",
        toolName: "bash",
        toolCallId: "tc-arr",
        isError: true,
        result: {
          content: [{ type: "text", text: "boom" }],
          details: ["not", "an", "object"],
        },
        durationMs: 1,
        instanceId,
      }),
      callbacks,
      state,
    );
    await handleObserveEvent(
      taskEvent({
        type: "tool",
        toolName: "bash",
        toolCallId: "tc-float",
        isError: true,
        result: { details: { command: "npm test", exitCode: 1.5 } },
        durationMs: 1,
        instanceId,
      }),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits.some((c) => c.includes("tool_failed: bash"))).toBe(true);
    expect(edits.some((c) => c.includes("boom"))).toBe(false);
    expect(edits.some((c) => c.includes("npm test"))).toBe(false);
    vi.useRealTimers();
  });
});

describe("progress overflow rolling", () => {
  it("rolls to a second bubble and targets it for subsequent edits", async () => {
    vi.useFakeTimers();
    const { callbacks, sent, edits, state, instanceId } = await rollingWorld();
    const sampleLine = formatToolLine("read_file", { path: fillerPath(0) });
    const fit = linesThatFit(sampleLine);
    const lines: string[] = [];
    for (let i = 0; i < fit + 1; i += 1) {
      const path = fillerPath(i);
      lines.push(formatToolLine("read_file", { path }));
      await handleObserveEvent(
        readFileEvent(path, instanceId),
        callbacks,
        state,
      );
    }
    await vi.runAllTimersAsync();

    expect(sent).toHaveLength(1);
    const secondId = sent[0]!.id;

    const firstEdits = edits.filter((e) => e.messageId === "status-1");
    expect(firstEdits).toHaveLength(1);
    expect(firstEdits[0]!.content).toBe(lines.slice(0, fit).join("\n"));

    const secondEdits = edits.filter((e) => e.messageId === secondId);
    expect(secondEdits).toHaveLength(1);
    expect(secondEdits[0]!.content).toBe(lines[fit]);
    vi.useRealTimers();
  });

  it("never sends or edits content longer than the Discord limit", async () => {
    vi.useFakeTimers();
    const { callbacks, sent, edits, state, instanceId } = await rollingWorld();
    for (let i = 0; i < 40; i += 1) {
      await handleObserveEvent(
        bashEvent(`step-${i}-` + "x".repeat(120), instanceId),
        callbacks,
        state,
      );
    }
    await vi.runAllTimersAsync();

    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const s of sent) {
      expect(s.content.length).toBeLessThanOrEqual(2000);
    }
    for (const e of edits) {
      expect(e.content.length).toBeLessThanOrEqual(2000);
    }
    vi.useRealTimers();
  });

  it("clamps a single tool line longer than the threshold via the backstop", async () => {
    vi.useFakeTimers();
    const { callbacks, sent, edits, state, instanceId } = await rollingWorld();
    await handleObserveEvent(
      longToolEvent("x".repeat(2000), instanceId),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();

    expect(sent).toHaveLength(0);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.messageId).toBe("status-1");
    expect(edits[0]!.content.length).toBeLessThanOrEqual(2000);
    expect(edits[0]!.content).toContain("truncated");
    vi.useRealTimers();
  });

  it("never cuts a bash code block across two bubbles", async () => {
    vi.useFakeTimers();
    const { callbacks, sent, edits, state, instanceId } = await rollingWorld();
    for (let i = 0; i < 40; i += 1) {
      await handleObserveEvent(
        bashEvent(`step ${i}: ` + "x".repeat(100), instanceId),
        callbacks,
        state,
      );
    }
    await vi.runAllTimersAsync();

    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const bubble of [...sent, ...edits]) {
      const fences = bubble.content.split("```").length - 1;
      expect(fences % 2, "unbalanced code fence across a bubble").toBe(0);
    }
    vi.useRealTimers();
  });

  it("coalesces a burst into one edit and re-edits at the 1500ms cadence", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state, instanceId } = await rollingWorld();

    await handleObserveEvent(
      bashEvent("echo one", instanceId),
      callbacks,
      state,
    );
    await vi.advanceTimersByTimeAsync(100);
    await handleObserveEvent(
      bashEvent("echo two", instanceId),
      callbacks,
      state,
    );
    await vi.advanceTimersByTimeAsync(1400);
    expect(edits).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    await handleObserveEvent(
      bashEvent("echo three", instanceId),
      callbacks,
      state,
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(edits).toHaveLength(2);
    vi.useRealTimers();
  });

  it("redacts a secret in a late-arriving tool arg in the second bubble", async () => {
    vi.useFakeTimers();
    const { callbacks, sent, edits, state, instanceId } = await rollingWorld();
    const secret = "ghp_aBcDeFgHiJkLmNoPqRsTuvw";
    const fillerLine = formatToolLine("read_file", { path: fillerPath(0) });
    const fit = linesThatFit(fillerLine);
    for (let i = 0; i < fit; i += 1) {
      await handleObserveEvent(
        readFileEvent(fillerPath(i), instanceId),
        callbacks,
        state,
      );
    }
    await handleObserveEvent(
      readFileEvent(secret + "x".repeat(30), instanceId),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();

    const secondId = sent[0]!.id;
    const secondContent = edits.filter((e) => e.messageId === secondId)[0]!
      .content;
    expect(secondContent).not.toContain(secret);
    expect(secondContent).toContain("[redacted]");
    vi.useRealTimers();
  });
});

describe("TaskStore progress-message migration", () => {
  it("synthesizes progressMessageIds from a legacy statusMessageId on read", async () => {
    const store = new InMemoryStore(1);
    const instanceId = toFlueInstanceId("thread-1");
    store.seedTask({
      id: "task-1",
      discordMessageId: "msg-1",
      discordThreadId: "thread-1",
      flueInstanceId: instanceId,
      workspacePath: "/workspaces/task-1",
      repo: "acme/web",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      instruction: "Do the work",
      setupProfileRevision: 2,
      status: "running",
      initialTurnStarted: true,
      statusMessageId: "old",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const read = await store.getByInstanceId(instanceId);
    expect(read?.progressMessageIds).toEqual(["old"]);
  });

  it("appends rolled bubble ids to progressMessageIds", async () => {
    const store = new InMemoryStore(1);
    const instanceId = toFlueInstanceId("thread-1");
    await store.createDraft({
      id: "task-1",
      discordMessageId: "msg-1",
      discordThreadId: "pending:task-1",
      flueInstanceId: "pending:task-1",
      workspacePath: "/workspaces/task-1",
      repo: "acme/web",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      instruction: "Do the work",
      setupProfileRevision: 2,
    });
    await store.attachAndPromote("task-1", "thread-1", instanceId, "status-1");
    await store.appendProgressMessageId("task-1", "status-2");
    await store.appendProgressMessageId("task-1", "status-3");

    const read = await store.getByInstanceId(instanceId);
    expect(read?.progressMessageIds).toEqual([
      "status-1",
      "status-2",
      "status-3",
    ]);
  });

  it("preserves a legacy statusMessageId when appending a rolled id", async () => {
    const store = new InMemoryStore(1);
    const instanceId = toFlueInstanceId("thread-1");
    store.seedTask({
      id: "task-1",
      discordMessageId: "msg-1",
      discordThreadId: "thread-1",
      flueInstanceId: instanceId,
      workspacePath: "/workspaces/task-1",
      repo: "acme/web",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      instruction: "Do the work",
      setupProfileRevision: 2,
      status: "running",
      initialTurnStarted: true,
      statusMessageId: "old",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await store.appendProgressMessageId("task-1", "rolled-1");

    const read = await store.getByInstanceId(instanceId);
    expect(read?.progressMessageIds).toEqual(["old", "rolled-1"]);
  });
});

describe("setup observe streaming", () => {
  it("edits the setup run progress message on tool events", async () => {
    vi.useFakeTimers();
    const { callbacks, edits, state } = recordingBridge();
    const setupStore = {
      getRunByInstanceId: async () => ({
        id: "run-abc",
        profileId: "profile-1",
        repo: "acme/web",
        branch: "main",
        model: "anthropic/claude-sonnet-4-5",
        workspacePath: "/workspaces/setup",
        status: "running",
        discordThreadId: "setup-thread-1",
        progressMessageIds: ["setup-status-1"],
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      appendProgressMessageId: async () => undefined,
    };
    (callbacks as unknown as { setupStore: typeof setupStore }).setupStore =
      setupStore;
    const instanceId = "setup:run-abc";
    await handleObserveEvent(
      bashEvent("npm test", instanceId),
      callbacks,
      state,
    );
    await vi.runAllTimersAsync();
    expect(edits[0]).toContain("npm test");
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
