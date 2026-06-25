import type { FlueEvent } from "@flue/runtime";
import { observe } from "@flue/runtime";
import { isThreadcordInstance } from "../ids.js";
import type { TaskStore } from "../task/store.js";
import { redact, summarizeError } from "../util/redact.js";
import type { DiscordPublisher } from "./publisher.js";
import { PROGRESS_ROLL_THRESHOLD } from "./limits.js";
import { formatToolLine, isTerminalBlock } from "./tool-format.js";

const PROGRESS_EDIT_INTERVAL_MS = 1500;

export interface ObserveBridgeCallbacks {
  store: TaskStore;
  publisher: DiscordPublisher;
  onAgentEnd: (instanceId: string) => Promise<void>;
  onAgentFailure: (instanceId: string, errorSummary: string) => Promise<void>;
}

export interface InstanceRenderState {
  lines: string[];
  lastLine: string | undefined;
  lastRenderedBase: string | undefined;
  repeatCount: number;
  lastWasTerminalBlock: boolean;
  bubbleStartIndex: number;
  currentBubbleCharCount: number;
}

interface ObserveBridgeState {
  renderState: Map<string, InstanceRenderState>;
  timers: Map<string, NodeJS.Timeout>;
  instanceChains: Map<string, Promise<void>>;
}

export function registerObserveBridge(args: ObserveBridgeCallbacks): void {
  const state: ObserveBridgeState = {
    renderState: new Map(),
    timers: new Map(),
    instanceChains: new Map(),
  };

  observe((event) => {
    const instanceId = "instanceId" in event ? event.instanceId : undefined;
    void withInstanceEventLock(instanceId, state, () =>
      handleObserveEvent(event, args, state),
    );
  });
}

export async function withInstanceEventLock(
  instanceId: string | undefined,
  state: ObserveBridgeState,
  fn: () => Promise<void>,
): Promise<void> {
  if (!instanceId) {
    await fn();
    return;
  }
  const previous = state.instanceChains.get(instanceId) ?? Promise.resolve();
  const next = previous.then(fn).catch(() => {});
  state.instanceChains.set(instanceId, next);
  await next;
}

export async function handleObserveEvent(
  event: FlueEvent,
  args: ObserveBridgeCallbacks,
  state: ObserveBridgeState = {
    renderState: new Map(),
    timers: new Map(),
    instanceChains: new Map(),
  },
): Promise<void> {
  const instanceId = "instanceId" in event ? event.instanceId : undefined;
  if (!instanceId) return;

  const isSetupInstance = instanceId.startsWith("setup:");
  const isTaskInstance = isThreadcordInstance(instanceId);

  const failureSummary = submissionFailureSummary(event);
  if (failureSummary && (isTaskInstance || isSetupInstance)) {
    await args.onAgentFailure(instanceId, failureSummary);
  }

  if (event.type === "agent_end" && (isTaskInstance || isSetupInstance)) {
    await args.onAgentEnd(instanceId);
  }
  if (!isTaskInstance) return;

  const line = eventSummary(event);
  if (!line) return;

  const terminal =
    event.type === "tool_start" && isTerminalBlock(event.toolName, event.args);

  const inst = state.renderState.get(instanceId) ?? newInstanceState();
  const outcome = appendRenderedLine(inst, line, terminal);
  state.renderState.set(instanceId, inst);

  if (outcome.kind === "new") {
    await maybeRoll(instanceId, inst, outcome.line, args);
  }

  if (!state.timers.has(instanceId)) {
    state.timers.set(
      instanceId,
      setTimeout(() => {
        state.timers.delete(instanceId);
        const current = state.renderState.get(instanceId);
        if (current && current.lines.length > 0) {
          void withInstanceEventLock(instanceId, state, () =>
            flush(instanceId, current, args),
          );
        }
      }, PROGRESS_EDIT_INTERVAL_MS),
    );
  }
}

function newInstanceState(): InstanceRenderState {
  return {
    lines: [],
    lastLine: undefined,
    lastRenderedBase: undefined,
    repeatCount: 0,
    lastWasTerminalBlock: false,
    bubbleStartIndex: 0,
    currentBubbleCharCount: 0,
  };
}

type AppendOutcome =
  | { kind: "repeat" }
  | { kind: "new"; line: string };

function appendRenderedLine(
  inst: InstanceRenderState,
  baseLine: string,
  terminal: boolean,
): AppendOutcome {
  if (inst.lastLine !== undefined && baseLine === inst.lastLine) {
    inst.repeatCount += 1;
    const base = inst.lastRenderedBase ?? baseLine;
    const prev = inst.lines[inst.lines.length - 1]!;
    const next = `${base} (×${inst.repeatCount})`;
    inst.lines[inst.lines.length - 1] = next;
    inst.currentBubbleCharCount += next.length - prev.length;
    inst.lastWasTerminalBlock = terminal;
    return { kind: "repeat" };
  }
  let line = baseLine;
  if (terminal && inst.lastWasTerminalBlock) {
    line = baseLine.slice(baseLine.indexOf("\n") + 1);
  }
  inst.lines.push(line);
  inst.lastLine = baseLine;
  inst.lastRenderedBase = line;
  inst.repeatCount = 1;
  inst.lastWasTerminalBlock = terminal;
  return { kind: "new", line };
}

export function shouldRollBubble(
  currentBubbleCharCount: number,
  nextLineLength: number,
  threshold: number = PROGRESS_ROLL_THRESHOLD,
): boolean {
  return (
    currentBubbleCharCount > 0 &&
    currentBubbleCharCount + 1 + nextLineLength > threshold
  );
}

async function maybeRoll(
  instanceId: string,
  inst: InstanceRenderState,
  newLine: string,
  args: Pick<ObserveBridgeCallbacks, "store" | "publisher">,
): Promise<void> {
  if (!shouldRollBubble(inst.currentBubbleCharCount, newLine.length)) {
    const wasEmpty = inst.currentBubbleCharCount === 0;
    inst.currentBubbleCharCount += (wasEmpty ? 0 : 1) + newLine.length;
    return;
  }

  let rolled = false;
  try {
    const task = await args.store.getByInstanceId(instanceId);
    const liveId = task?.progressMessageIds?.[task.progressMessageIds.length - 1];
    if (task && liveId) {
      const frozenContent = inst.lines
        .slice(inst.bubbleStartIndex, inst.lines.length - 1)
        .map((line) => redact(line))
        .join("\n");
      await args.publisher.edit(task.discordThreadId, liveId, frozenContent);
      const sent = await args.publisher.send(
        task.discordThreadId,
        redact(newLine),
      );
      await args.store.appendProgressMessageId(task.id, sent.id);
      rolled = true;
    }
  } catch (error) {
    console.error(
      `[threadcord] progress roll failed for ${instanceId}`,
      error,
    );
    rolled = false;
  }

  if (rolled) {
    inst.bubbleStartIndex = inst.lines.length - 1;
    inst.currentBubbleCharCount = newLine.length;
  } else {
    inst.currentBubbleCharCount += 1 + newLine.length;
  }
}

async function flush(
  instanceId: string,
  inst: InstanceRenderState,
  args: Pick<ObserveBridgeCallbacks, "store" | "publisher">,
): Promise<void> {
  const task = await args.store.getByInstanceId(instanceId);
  const liveId = task?.progressMessageIds?.[task.progressMessageIds.length - 1];
  if (!liveId) return;
  const content = inst.lines
    .slice(inst.bubbleStartIndex)
    .map((line) => redact(line))
    .join("\n");
  await args.publisher.edit(task.discordThreadId, liveId, content);
}

export function submissionFailureSummary(event: FlueEvent): string | undefined {
  if (event.type === "submission_settled" && event.outcome === "failed") {
    return formatFlueError(event.error) ?? "Submission failed";
  }
  if (event.type === "turn" && event.isError) {
    return formatFlueError(event.error) ?? "Model turn failed";
  }
  if (event.type === "operation" && event.isError) {
    return formatFlueError(event.error) ?? "Agent operation failed";
  }
  return undefined;
}

function formatFlueError(error: unknown): string | undefined {
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  return undefined;
}

function eventSummary(event: FlueEvent): string | undefined {
  switch (event.type) {
    case "turn_start":
      return "Model turn started";
    case "tool_start":
      return formatToolLine(event.toolName, event.args);
    case "agent_end":
      return "Agent turn completed";
    case "log":
      return `${event.level}: ${event.message}`;
    default:
      return undefined;
  }
}

export function failureDiscordMessage(errorSummary: string): string {
  const summary = summarizeError(new Error(errorSummary));
  if (/finish_reason/i.test(summary)) {
    return `Failed: ${summary}. The model provider stream ended before completion. This turn was not replayed.`;
  }
  return `Failed: ${summary}. This turn was not replayed automatically.`;
}
