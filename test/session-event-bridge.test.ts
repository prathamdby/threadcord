import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cacheConfig } from "../src/config.js";
import { toAgentInstanceId } from "../src/ids.js";
import {
  registerSessionEventBridge,
  type SessionEventBridge,
} from "../src/discord/session-event-bridge.js";
import type { ObserveBridgeCallbacks } from "../src/discord/observe-bridge.js";
import { DurableConversationLog, type ConversationLog } from "../src/agentturn/conversation-log.js";
import { InMemoryConversationLogStore } from "./support/conversation-log-store.js";
import { InMemoryStore } from "./support/orchestrator-harness.js";
import { config } from "./support/orchestrator-harness.js";
import { resetToolFailureGuardsForTests } from "../src/discord/tool-failure-guard.js";

beforeEach(() => {
  cacheConfig(config);
  resetToolFailureGuardsForTests();
});

function recordingBridge(): {
  callbacks: ObserveBridgeCallbacks;
  edits: string[];
  sends: { id: string; content: string }[];
  onAgentEnd: Mock;
  onAgentFailure: Mock;
  bridge: SessionEventBridge;
  log: ConversationLog;
  store: InMemoryStore;
} {
  const edits: string[] = [];
  const sends: { id: string; content: string }[] = [];
  const onAgentEnd = vi.fn(async () => {});
  const onAgentFailure = vi.fn(async () => {});
  let sendSeq = 2;

  const store = new InMemoryStore(1);
  store.seedTask({
    id: "task-1",
    discordMessageId: "msg-1",
    discordThreadId: "thread-1",
    agentInstanceId: toAgentInstanceId("thread-1"),
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
  });

  const callbacks = {
    store,
    publisher: {
      edit: async (_threadId: string, _messageId: string, content: string) => {
        edits.push(content);
      },
      send: async (_threadId: string, content: string) => {
        const id = `status-${sendSeq++}`;
        sends.push({ id, content });
        return { id };
      },
    },
    onAgentEnd,
    onAgentFailure,
  } as unknown as ObserveBridgeCallbacks;

  const log = new DurableConversationLog(new InMemoryConversationLogStore());
  const bridge = registerSessionEventBridge(callbacks);

  return { callbacks, edits, sends, onAgentEnd, onAgentFailure, bridge, log, store };
}

const instanceId = toAgentInstanceId("thread-1");

describe("SessionEventBridge", () => {
  it("maps a text delta to a progress line", async () => {
    vi.useFakeTimers();
    const { bridge, edits } = recordingBridge();

    await bridge.handleEvent({
      type: "text_delta",
      instanceId,
      delta: "hello world",
    });
    await vi.runAllTimersAsync();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("hello world");
    vi.useRealTimers();
  });

  it("maps an agent message to a formatted progress line", async () => {
    vi.useFakeTimers();
    const { bridge, edits } = recordingBridge();

    await bridge.handleEvent({
      type: "agent_message",
      instanceId,
      content: "I found the issue.",
    });
    await vi.runAllTimersAsync();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("I found the issue.");
    vi.useRealTimers();
  });

  it("maps a tool start to a formatToolLine progress line", async () => {
    vi.useFakeTimers();
    const { bridge, edits } = recordingBridge();

    await bridge.handleEvent({
      type: "tool_start",
      instanceId,
      toolName: "read_file",
      args: { path: "src/main.py" },
      toolCallId: "tc-1",
    });
    await vi.runAllTimersAsync();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('📖 read_file: "src/main.py"');
    vi.useRealTimers();
  });

  it("adds no line for a successful tool result", async () => {
    vi.useFakeTimers();
    const { bridge, edits } = recordingBridge();

    await bridge.handleEvent({
      type: "tool_start",
      instanceId,
      toolName: "read_file",
      args: { path: "src/main.py" },
      toolCallId: "tc-1",
    });
    await bridge.handleEvent({
      type: "tool_result",
      instanceId,
      toolName: "read_file",
      toolCallId: "tc-1",
      isError: false,
      result: "file content",
    });
    await vi.runAllTimersAsync();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('📖 read_file: "src/main.py"');
    vi.useRealTimers();
  });

  it("maps a tool result error to a formatToolFailureLine", async () => {
    vi.useFakeTimers();
    const { bridge, edits } = recordingBridge();

    await bridge.handleEvent({
      type: "tool_start",
      instanceId,
      toolName: "bash",
      args: { command: "npm test" },
      toolCallId: "tc-err",
    });
    await bridge.handleEvent({
      type: "tool_result",
      instanceId,
      toolName: "bash",
      toolCallId: "tc-err",
      isError: true,
      result: "npm test failed",
    });
    await vi.runAllTimersAsync();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("💻 bash");
    expect(edits[0]).toContain("tool call failed");
    expect(edits[0]).not.toContain("npm test failed");
    vi.useRealTimers();
  });

  it("posts a milestone and calls onAgentEnd when the turn completes", async () => {
    vi.useFakeTimers();
    const { bridge, sends, onAgentEnd } = recordingBridge();

    await bridge.handleEvent({ type: "turn_completed", instanceId });
    await vi.runAllTimersAsync();

    expect(sends).toHaveLength(1);
    expect(sends[0]?.content).toContain("Agent turn completed");
    expect(onAgentEnd).toHaveBeenCalledWith(instanceId);
    vi.useRealTimers();
  });

  it("calls onAgentFailure when the turn fails", async () => {
    vi.useFakeTimers();
    const { bridge, sends, onAgentFailure } = recordingBridge();

    await bridge.handleEvent({
      type: "turn_failed",
      instanceId,
      summary: "model provider error",
    });
    await vi.runAllTimersAsync();

    expect(onAgentFailure).toHaveBeenCalledWith(instanceId, "model provider error");
    vi.useRealTimers();
  });

  it("posts a cancellation milestone and calls onAgentEnd", async () => {
    vi.useFakeTimers();
    const { bridge, sends, onAgentEnd } = recordingBridge();

    await bridge.handleEvent({ type: "turn_cancelled", instanceId });
    await vi.runAllTimersAsync();

    expect(sends).toHaveLength(1);
    expect(sends[0]?.content).toContain("Agent turn cancelled");
    expect(onAgentEnd).toHaveBeenCalledWith(instanceId);
    vi.useRealTimers();
  });

  it("posts a Model turn started milestone and resets the tool-failure guard", async () => {
    vi.useFakeTimers();
    const { bridge, sends } = recordingBridge();

    // Trip the guard with consecutive validation failures.
    for (let i = 0; i < 3; i++) {
      await bridge.handleEvent({
        type: "tool_result",
        instanceId,
        toolName: "glob",
        toolCallId: `tc-val-${i}`,
        isError: true,
        result: "Validation failed: must have required properties",
      });
    }

    await bridge.handleEvent({ type: "turn_start", instanceId });

    // After the guard reset, another streak must start from zero.
    for (let i = 0; i < 2; i++) {
      await bridge.handleEvent({
        type: "tool_result",
        instanceId,
        toolName: "glob",
        toolCallId: `tc-val2-${i}`,
        isError: true,
        result: "Validation failed: must have required properties",
      });
    }
    await vi.runAllTimersAsync();

    expect(sends.some((s) => s.content.includes("Model turn started"))).toBe(true);
    vi.useRealTimers();
  });

  it("triggers onAgentFailure for a permission failure", async () => {
    vi.useFakeTimers();
    const { bridge, onAgentFailure } = recordingBridge();

    await bridge.handleEvent({
      type: "permission_failure",
      instanceId,
      summary: "attempted disallowed action",
    });
    await vi.runAllTimersAsync();

    expect(onAgentFailure).toHaveBeenCalledWith(instanceId, "attempted disallowed action");
    vi.useRealTimers();
  });

  it("validates final output and queues a user-turn message", async () => {
    vi.useFakeTimers();
    const { bridge, onAgentEnd } = recordingBridge();
    const content = "## Summary\n\nI changed the file and verified the fix.";

    await bridge.handleEvent({
      type: "final_output",
      instanceId,
      content,
    });
    await bridge.handleEvent({ type: "turn_completed", instanceId });
    await vi.runAllTimersAsync();

    expect(onAgentEnd).toHaveBeenCalledWith(instanceId);
    vi.useRealTimers();
  });

  it("rejects invalid final output and calls onAgentFailure", async () => {
    vi.useFakeTimers();
    const { bridge, onAgentFailure } = recordingBridge();

    await bridge.handleEvent({
      type: "final_output",
      instanceId,
      content: "Done.",
    });
    await vi.runAllTimersAsync();

    expect(onAgentFailure).toHaveBeenCalledTimes(1);
    expect(onAgentFailure.mock.calls[0]?.[1]).toContain("must contain at least one ## section header");
    vi.useRealTimers();
  });

  it("posts an environment issue milestone", async () => {
    vi.useFakeTimers();
    const { bridge, sends } = recordingBridge();

    await bridge.handleEvent({
      type: "environment_issue",
      instanceId,
      summary: "missing ANTHROPIC_API_KEY",
    });
    await vi.runAllTimersAsync();

    expect(sends).toHaveLength(1);
    expect(sends[0]?.content).toContain("Environment issue");
    expect(sends[0]?.content).toContain("missing ANTHROPIC_API_KEY");
    vi.useRealTimers();
  });

  it("renders an unknown event as a bounded generic progress line", async () => {
    vi.useFakeTimers();
    const { bridge, edits } = recordingBridge();

    await bridge.handleEvent({
      type: "unknown",
      instanceId,
      rawType: "session/custom",
      payload: { secret: "ghp_aBcDeFgHiJkLmNoPqRsTuvw" },
    });
    await vi.runAllTimersAsync();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toBe("Agent activity...");
    vi.useRealTimers();
  });

  it("redacts secrets in progress lines", async () => {
    vi.useFakeTimers();
    const { bridge, edits } = recordingBridge();
    const secret = "ghp_aBcDeFgHiJkLmNoPqRsTuvw";

    await bridge.handleEvent({
      type: "text_delta",
      instanceId,
      delta: `auth ${secret}`,
    });
    await vi.runAllTimersAsync();

    expect(edits[0]).toContain("[redacted]");
    expect(edits[0]).not.toContain(secret);
    vi.useRealTimers();
  });

  it("coalesces a burst of text deltas into one edit", async () => {
    vi.useFakeTimers();
    const { bridge, edits } = recordingBridge();

    await bridge.handleEvent({ type: "text_delta", instanceId, delta: "one " });
    await vi.advanceTimersByTimeAsync(100);
    await bridge.handleEvent({ type: "text_delta", instanceId, delta: "two " });
    await vi.advanceTimersByTimeAsync(1400);
    expect(edits).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    await bridge.handleEvent({ type: "text_delta", instanceId, delta: "three" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(edits).toHaveLength(2);
    vi.useRealTimers();
  });

  it("does not persist events to ConversationLog (projection only)", async () => {
    vi.useFakeTimers();
    const { bridge, log } = recordingBridge();

    await bridge.handleEvent({ type: "text_delta", instanceId, delta: "hello" });
    await bridge.handleEvent({
      type: "tool_start",
      instanceId,
      toolName: "read_file",
      args: { path: "src/main.py" },
      toolCallId: "tc-1",
    });
    await bridge.handleEvent({ type: "turn_completed", instanceId });
    await vi.runAllTimersAsync();

    const transcript = await log.rebuildTranscript(instanceId);
    expect(transcript).toHaveLength(0);
    vi.useRealTimers();
  });

  it("serializes events per instance so renders do not interleave", async () => {
    vi.useFakeTimers();
    const instanceA = toAgentInstanceId("thread-a");
    const instanceB = toAgentInstanceId("thread-b");
    const { bridge, edits } = recordingBridge();

    // Ensure both instances are resolvable in the shared store.
    const store = new InMemoryStore(1);
    store.seedTask({
      id: "task-a",
      discordMessageId: "msg-a",
      discordThreadId: "thread-a",
      agentInstanceId: instanceA,
      workspacePath: "/workspaces/task-a",
      repo: "acme/web",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      instruction: "Do the work",
      setupProfileRevision: 2,
      status: "running",
      initialTurnStarted: true,
      progressMessageIds: ["status-a"],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    store.seedTask({
      id: "task-b",
      discordMessageId: "msg-b",
      discordThreadId: "thread-b",
      agentInstanceId: instanceB,
      workspacePath: "/workspaces/task-b",
      repo: "acme/web",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      instruction: "Do the work",
      setupProfileRevision: 2,
      status: "running",
      initialTurnStarted: true,
      progressMessageIds: ["status-b"],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const callbacks = {
      store,
      publisher: {
        edit: async (_threadId: string, _messageId: string, content: string) => {
          edits.push(content);
        },
        send: async (_threadId: string, content: string) => ({ id: content }),
      },
      onAgentEnd: async () => {},
      onAgentFailure: async () => {},
    } as unknown as ObserveBridgeCallbacks;
    const log = new DurableConversationLog(new InMemoryConversationLogStore());
    const serialBridge = registerSessionEventBridge(callbacks);

    await Promise.all([
      serialBridge.handleEvent({ type: "text_delta", instanceId: instanceA, delta: "A1" }),
      serialBridge.handleEvent({ type: "text_delta", instanceId: instanceB, delta: "B1" }),
      serialBridge.handleEvent({ type: "text_delta", instanceId: instanceA, delta: "A2" }),
      serialBridge.handleEvent({ type: "text_delta", instanceId: instanceB, delta: "B2" }),
    ]);
    await vi.runAllTimersAsync();

    const editsForA = edits.filter((content) => content.includes("A1") || content.includes("A2"));
    const editsForB = edits.filter((content) => content.includes("B1") || content.includes("B2"));
    expect(editsForA).toHaveLength(1);
    expect(editsForB).toHaveLength(1);
    expect(editsForA[0]).toContain("A1");
    expect(editsForA[0]).toContain("A2");
    expect(editsForB[0]).toContain("B1");
    expect(editsForB[0]).toContain("B2");
    vi.useRealTimers();
  });

  it("collapses consecutive identical progress lines with a counter", async () => {
    vi.useFakeTimers();
    const { bridge, edits } = recordingBridge();

    for (let i = 0; i < 3; i++) {
      await bridge.handleEvent({
        type: "text_delta",
        instanceId,
        delta: "thinking...",
      });
    }
    await vi.runAllTimersAsync();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("thinking...");
    expect(edits[0]).toContain("(×3)");
    vi.useRealTimers();
  });

  it("rolls to a second bubble when progress exceeds the threshold", async () => {
    vi.useFakeTimers();
    const lineA = "A".repeat(1900);
    const lineB = "B".repeat(1900);
    const { bridge, edits, sends } = recordingBridge();

    await bridge.handleEvent({ type: "text_delta", instanceId, delta: lineA });
    await bridge.handleEvent({ type: "text_delta", instanceId, delta: lineB });
    await vi.runAllTimersAsync();

    expect(sends.length).toBeGreaterThanOrEqual(1);
    const firstEdits = edits.filter((e) => e === lineA);
    expect(firstEdits).toHaveLength(1);
    vi.useRealTimers();
  });

  it("relativizes tool paths against the setup repo root", async () => {
    vi.useFakeTimers();
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
    const edits: string[] = [];
    const callbacks = {
      store: {
        getByInstanceId: async () => undefined,
        appendProgressMessageId: async () => undefined,
      },
      setupStore,
      publisher: {
        edit: async (_threadId: string, _messageId: string, content: string) => {
          edits.push(content);
        },
        send: async (_threadId: string, content: string) => ({ id: content }),
      },
      onAgentEnd: async () => {},
      onAgentFailure: async () => {},
    } as unknown as ObserveBridgeCallbacks;
    const log = new DurableConversationLog(new InMemoryConversationLogStore());
    const bridge = registerSessionEventBridge(callbacks);

    await bridge.handleEvent({
      type: "tool_start",
      instanceId: "setup:run-abc",
      toolName: "read_file",
      args: { path: "/workspaces/setup/web/src/main.py" },
      toolCallId: "tc-1",
    });
    await vi.runAllTimersAsync();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('📖 read_file: "src/main.py"');
    vi.useRealTimers();
  });

  it("never sends raw JSON to Discord for an unknown event", async () => {
    vi.useFakeTimers();
    const { bridge, edits, sends } = recordingBridge();

    await bridge.handleEvent({
      type: "unknown",
      instanceId,
      rawType: "session/custom",
      payload: { nested: { value: "secret" } },
    });
    await vi.runAllTimersAsync();

    const allOutput = [...edits, ...sends.map((s) => s.content)].join("\n");
    expect(allOutput).not.toContain("{");
    expect(allOutput).not.toContain("}");
    expect(allOutput).not.toContain("\"nested\"");
    expect(allOutput).not.toContain("rawType");
    vi.useRealTimers();
  });

  it("renders progress lines without persisting to ConversationLog", async () => {
    vi.useFakeTimers();
    const { bridge, log } = recordingBridge();

    await bridge.handleEvent({ type: "text_delta", instanceId, delta: "hello" });
    await vi.runAllTimersAsync();

    const events = await log.rebuildTranscript(instanceId);
    expect(events).toHaveLength(0);
    vi.useRealTimers();
  });

  it("projects canonical events after durable persistence", async () => {
    vi.useFakeTimers();
    const { bridge, log } = recordingBridge();

    await log.append({
      session_id: instanceId,
      turn_id: "turn-1",
      attempt_id: "attempt-1",
      event_kind: "text_delta",
      payload: { delta: "hello" },
    });
    await bridge.handleEvent({ type: "text_delta", instanceId, delta: "hello" });
    await vi.runAllTimersAsync();

    const events = await log.rebuildTranscript(instanceId);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_kind).toBe("text_delta");
    expect(events[0]?.id).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("excludes superseded attempt events from canonical transcript", async () => {
    vi.useFakeTimers();
    const { log } = recordingBridge();
    const attempt1 = "attempt-1";
    const attempt2 = "attempt-2";

    await log.append({
      session_id: instanceId,
      turn_id: "turn-1",
      attempt_id: attempt1,
      event_kind: "text_delta",
      payload: { delta: "stale" },
    });
    await log.append({
      session_id: instanceId,
      turn_id: "turn-1",
      attempt_id: attempt2,
      event_kind: "text_delta",
      payload: { delta: "canonical" },
    });
    await log.markSuperseded(attempt1);

    const transcript = await log.rebuildTranscript(instanceId);
    expect(transcript.map((event) => event.payload)).toEqual([
      { delta: "canonical" },
    ]);
    vi.useRealTimers();
  });

  it("clears pending tool starts after a terminal event", async () => {
    vi.useFakeTimers();
    const terminalTypes: Array<"turn_completed" | "turn_failed" | "turn_cancelled"> = [
      "turn_completed",
      "turn_failed",
      "turn_cancelled",
    ];

    for (const terminalType of terminalTypes) {
      const { bridge } = recordingBridge();
      const pendingToolStarts = (bridge as unknown as { state: { pendingToolStarts: Map<string, unknown> } }).state.pendingToolStarts;

      await bridge.handleEvent({
        type: "tool_start",
        instanceId,
        toolName: "read_file",
        args: { path: "src/main.py" },
        toolCallId: `tc-${terminalType}`,
      });
      expect(pendingToolStarts.size).toBe(1);

      const terminalEvent =
        terminalType === "turn_failed"
          ? { type: terminalType, instanceId, summary: "model error" }
          : { type: terminalType, instanceId };
      await bridge.handleEvent(terminalEvent as any);
      await vi.runAllTimersAsync();

      expect(pendingToolStarts.size).toBe(0);
    }
    vi.useRealTimers();
  });

  it("rebuilds the status message from canonical events after supersession", async () => {
    vi.useFakeTimers();
    const { bridge, edits, log } = recordingBridge();
    const attempt1 = "attempt-1";
    const attempt2 = "attempt-2";

    await log.append({
      session_id: instanceId,
      turn_id: "turn-1",
      attempt_id: attempt1,
      event_kind: "text_delta",
      payload: { delta: "stale" },
    });
    await log.append({
      session_id: instanceId,
      turn_id: "turn-1",
      attempt_id: attempt2,
      event_kind: "text_delta",
      payload: { delta: "canonical" },
    });

    await bridge.handleEvent({
      type: "text_delta",
      instanceId,
      attemptId: attempt1,
      delta: "stale",
    });
    await bridge.handleEvent({
      type: "text_delta",
      instanceId,
      attemptId: attempt2,
      delta: "canonical",
    });
    await vi.runAllTimersAsync();

    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("stale");
    expect(edits[0]).toContain("canonical");

    await log.markSuperseded(attempt1);
    const canonical = await log.projectForDiscord(instanceId);
    expect(canonical.map((event) => event.payload)).toEqual([
      { delta: "canonical" },
    ]);

    await bridge.rebuildStatus(instanceId, canonical);
    await vi.runAllTimersAsync();

    // After rebuild, the status message should only contain canonical content.
    expect(edits[edits.length - 1]).toContain("canonical");
    expect(edits[edits.length - 1]).not.toContain("stale");
    vi.useRealTimers();
  });
});
