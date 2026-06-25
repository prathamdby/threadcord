import type { FlueEvent } from "@flue/runtime";
import { observe } from "@flue/runtime";
import { isThreadcordInstance } from "../ids.js";
import type { TaskStore } from "../task/store.js";
import { redact, summarizeError } from "../util/redact.js";
import type { DiscordPublisher } from "./publisher.js";
import { formatToolLine, isTerminalBlock } from "./tool-format.js";

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
    void withInstanceEventLock(event, state, () =>
      handleObserveEvent(event, args, state),
    );
  });
}

export async function withInstanceEventLock(
  event: FlueEvent,
  state: ObserveBridgeState,
  fn: () => Promise<void>,
): Promise<void> {
  const instanceId = "instanceId" in event ? event.instanceId : undefined;
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
  if (failureSummary && isTaskInstance) {
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
  appendRenderedLine(inst, line, terminal);
  state.renderState.set(instanceId, inst);

  const existing = state.timers.get(instanceId);
  if (existing) clearTimeout(existing);
  state.timers.set(
    instanceId,
    setTimeout(() => {
      state.timers.delete(instanceId);
      const current = state.renderState.get(instanceId);
      if (current && current.lines.length > 0) {
        void flush(instanceId, current, args);
      }
    }, 2500),
  );
}

function newInstanceState(): InstanceRenderState {
  return {
    lines: [],
    lastLine: undefined,
    lastRenderedBase: undefined,
    repeatCount: 0,
    lastWasTerminalBlock: false,
  };
}

function appendRenderedLine(
  inst: InstanceRenderState,
  baseLine: string,
  terminal: boolean,
): void {
  if (inst.lastLine !== undefined && baseLine === inst.lastLine) {
    inst.repeatCount += 1;
    const base = inst.lastRenderedBase ?? baseLine;
    inst.lines[inst.lines.length - 1] = `${base} (×${inst.repeatCount})`;
    inst.lastWasTerminalBlock = terminal;
    return;
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
}

async function flush(
  instanceId: string,
  inst: InstanceRenderState,
  args: Pick<ObserveBridgeCallbacks, "store" | "publisher">,
): Promise<void> {
  const task = await args.store.getByInstanceId(instanceId);
  if (!task?.statusMessageId) return;
  await args.publisher.edit(
    task.discordThreadId,
    task.statusMessageId,
    inst.lines.map((line) => redact(line)).join("\n"),
  );
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
