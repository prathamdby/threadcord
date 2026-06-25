import type { FlueEvent } from "@flue/runtime";
import { observe } from "@flue/runtime";
import { isThreadcordInstance } from "../ids.js";
import {
  setupProgressSessionFromRun,
  type SetupProgressSession,
} from "../setup/progress-session.js";
import type { SetupStore } from "../setup/store.js";
import type { TaskStore } from "../task/store.js";
import { redact, summarizeError } from "../util/redact.js";
import type { DiscordPublisher } from "./publisher.js";
import {
  appendRenderedLine,
  flushProgressMessage,
  maybeRollProgressMessage,
  newInstanceRenderState,
  type InstanceRenderState,
  type ProgressStreamStore,
  type ProgressStreamTarget,
} from "./progress-stream.js";
import { formatToolLine, isTerminalBlock } from "./tool-format.js";

const PROGRESS_EDIT_INTERVAL_MS = 1500;

export interface ObserveBridgeCallbacks {
  store: TaskStore;
  setupStore?: SetupStore;
  publisher: DiscordPublisher;
  onAgentEnd: (instanceId: string) => Promise<void>;
  onAgentFailure: (instanceId: string, errorSummary: string) => Promise<void>;
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

  if (!isTaskInstance && !isSetupInstance) return;

  const line = eventSummary(event);
  if (!line) return;

  const terminal =
    event.type === "tool_start" && isTerminalBlock(event.toolName, event.args);

  const inst = state.renderState.get(instanceId) ?? newInstanceRenderState();
  const outcome = appendRenderedLine(inst, line, terminal);
  state.renderState.set(instanceId, inst);

  const stream = await resolveProgressStream(instanceId, args);
  if (outcome.kind === "new") {
    await maybeRollProgressMessage(
      stream.id,
      inst,
      outcome.line,
      stream.target,
      stream.store,
      args.publisher,
    );
  }

  if (!state.timers.has(instanceId)) {
    state.timers.set(
      instanceId,
      setTimeout(() => {
        state.timers.delete(instanceId);
        const current = state.renderState.get(instanceId);
        if (current && current.lines.length > 0) {
          void withInstanceEventLock(instanceId, state, async () => {
            const resolved = await resolveProgressStream(instanceId, args);
            await flushProgressMessage(
              resolved.target,
              current,
              args.publisher,
            );
          });
        }
      }, PROGRESS_EDIT_INTERVAL_MS),
    );
  }
}

async function resolveProgressStream(
  instanceId: string,
  args: ObserveBridgeCallbacks,
): Promise<{
  id: string;
  target: ProgressStreamTarget | undefined;
  store: ProgressStreamStore | undefined;
}> {
  if (isThreadcordInstance(instanceId)) {
    const task = await args.store.getByInstanceId(instanceId);
    if (!task?.progressMessageIds?.length) {
      return { id: task?.id ?? instanceId, target: undefined, store: undefined };
    }
    return {
      id: task.id,
      target: {
        threadId: task.discordThreadId,
        progressMessageIds: task.progressMessageIds,
      },
      store: {
        appendProgressMessageId: async (id, messageId) => {
          void (await args.store.appendProgressMessageId(id, messageId));
        },
      },
    };
  }
  if (instanceId.startsWith("setup:") && args.setupStore) {
    const run = await args.setupStore.getRunByInstanceId(instanceId);
    const session: SetupProgressSession | undefined = run
      ? setupProgressSessionFromRun(run)
      : undefined;
    if (!session) {
      return { id: instanceId.slice(6), target: undefined, store: undefined };
    }
    return {
      id: session.id,
      target: {
        threadId: session.discordThreadId,
        progressMessageIds: session.progressMessageIds,
      },
      store: {
        appendProgressMessageId: async (id, messageId) => {
          await args.setupStore!.appendProgressMessageId(id, messageId);
        },
      },
    };
  }
  return { id: instanceId, target: undefined, store: undefined };
}

export { shouldRollBubble } from "./progress-stream.js";

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