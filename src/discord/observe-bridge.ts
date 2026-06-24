import type { FlueEvent } from "@flue/runtime";
import { observe } from "@flue/runtime";
import { isThreadcordInstance } from "../ids.js";
import type { TaskStore } from "../task/store.js";
import { redact, summarizeError } from "../util/redact.js";
import type { DiscordPublisher } from "./publisher.js";

export interface ObserveBridgeCallbacks {
  store: TaskStore;
  publisher: DiscordPublisher;
  onAgentEnd: (instanceId: string) => Promise<void>;
  onAgentFailure: (instanceId: string, errorSummary: string) => Promise<void>;
}

interface ObserveBridgeState {
  buffers: Map<string, string[]>;
  timers: Map<string, NodeJS.Timeout>;
}

export function registerObserveBridge(args: ObserveBridgeCallbacks): void {
  const state: ObserveBridgeState = {
    buffers: new Map(),
    timers: new Map(),
  };

  observe((event) => {
    void handleObserveEvent(event, args, state);
  });
}

export async function handleObserveEvent(
  event: FlueEvent,
  args: ObserveBridgeCallbacks,
  state: ObserveBridgeState = { buffers: new Map(), timers: new Map() },
): Promise<void> {
  const instanceId = "instanceId" in event ? event.instanceId : undefined;
  if (!instanceId) return;

  const isSetupInstance = instanceId.startsWith("setup:");
  const isTaskInstance = isThreadcordInstance(instanceId);

  const failureSummary = submissionFailureSummary(event);
  if (failureSummary && isTaskInstance) {
    void args.onAgentFailure(instanceId, failureSummary);
  }

  if (event.type === "agent_end" && (isTaskInstance || isSetupInstance)) {
    void args.onAgentEnd(instanceId);
  }
  if (!isTaskInstance) return;

  const line = eventSummary(event);
  if (!line) return;

  const current = state.buffers.get(instanceId) ?? [];
  current.push(line);
  state.buffers.set(instanceId, current.slice(-8));

  const existing = state.timers.get(instanceId);
  if (existing) clearTimeout(existing);
  state.timers.set(
    instanceId,
    setTimeout(() => {
      state.timers.delete(instanceId);
      void flush(instanceId, state.buffers.get(instanceId) ?? [], args);
    }, 2500),
  );
}

async function flush(
  instanceId: string,
  lines: string[],
  args: Pick<ObserveBridgeCallbacks, "store" | "publisher">,
): Promise<void> {
  const task = await args.store.getByInstanceId(instanceId);
  if (!task?.statusMessageId) return;
  await args.publisher.edit(
    task.discordThreadId,
    task.statusMessageId,
    `Status\n${lines.map((line) => `- ${redact(line)}`).join("\n")}`,
  );
}

export function submissionFailureSummary(event: FlueEvent): string | undefined {
  if (event.type === "submission_settled" && event.outcome === "failed") {
    return event.error?.trim() || "Submission failed";
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
    case "agent_start":
      return "Agent started";
    case "turn_start":
      return `Model turn started (${event.purpose})`;
    case "tool_start":
      return `Tool started: ${event.toolName}`;
    case "tool":
      return `Tool finished: ${event.toolName}`;
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
