import { posix } from "node:path";
import type { FlueEvent } from "@flue/runtime";
import { observe } from "@flue/runtime";
import { getRuntimeConfig } from "../config.js";
import {
  DEFAULT_AGENT_MAX_TOOL_FAILURES,
  resolveAgentMaxToolFailures,
} from "../flue/agent-guardrails.js";
import {
  maybeAbortOnToolFailures,
  noteAgentTurnBoundary,
} from "../flue/tool-failure-guard.js";
import { isThreadcordInstance } from "../ids.js";
import { checkoutPathForTask } from "../task/turn-context.js";
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

  const maxToolFailures = resolveMaxToolFailuresForObserve();

  if (event.type === "turn_start" && (isTaskInstance || isSetupInstance)) {
    noteAgentTurnBoundary(instanceId);
  }

  const toolFailureTrip = await maybeAbortOnToolFailures(
    event,
    instanceId,
    maxToolFailures,
  );
  if (toolFailureTrip && (isTaskInstance || isSetupInstance)) {
    await args.onAgentFailure(instanceId, toolFailureTrip);
  }

  const failureSummary = submissionFailureSummary(event);
  if (failureSummary && (isTaskInstance || isSetupInstance)) {
    await args.onAgentFailure(instanceId, failureSummary);
  }

  if (event.type === "agent_end" && (isTaskInstance || isSetupInstance)) {
    await args.onAgentEnd(instanceId);
  }

  if (!isTaskInstance && !isSetupInstance) return;

  const line = await eventSummary(event, instanceId, args);
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
      return {
        id: task?.id ?? instanceId,
        target: undefined,
        store: undefined,
      };
    }
    return {
      id: task.id,
      target: {
        threadId: task.discordThreadId,
        progressMessageIds: task.progressMessageIds,
      },
      store: {
        appendProgressMessageId: async (id, messageId) => {
          await args.store.appendProgressMessageId(id, messageId);
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
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const obj = error as Record<string, unknown>;
    const contentText = extractContentArrayText(obj.content);
    const detailSuffix = formatErrorDetails(obj.details);
    if (contentText && detailSuffix) {
      return `${contentText}\n${detailSuffix}`;
    }
    if (contentText) return contentText;
    if (detailSuffix) return detailSuffix;
    if (typeof obj.message === "string" && obj.message.trim().length > 0) {
      return obj.message.trim();
    }
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return undefined;
}

function extractContentArrayText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== undefined && b.type !== "text") continue;
    if (typeof b.text !== "string" || b.text.trim().length === 0) continue;
    texts.push(b.text);
  }
  return texts.length > 0 ? texts.join("\n").trim() : undefined;
}

function formatErrorDetails(details: unknown): string | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details))
    return undefined;
  const d = details as Record<string, unknown>;
  const command = typeof d.command === "string" ? d.command.trim() : "";
  const hasExitCode = Number.isInteger(d.exitCode);
  if (command && hasExitCode) {
    return `${command} exited with code ${d.exitCode}`;
  }
  if (command) return command;
  if (hasExitCode) return `exited with code ${d.exitCode}`;
  return undefined;
}

async function eventSummary(
  event: FlueEvent,
  instanceId: string,
  bridge: ObserveBridgeCallbacks,
): Promise<string | undefined> {
  switch (event.type) {
    case "turn_start":
      return "Model turn started";
    case "tool_start": {
      const repoRoot = await resolveRepoRootForInstance(instanceId, bridge);
      return formatToolLine(
        event.toolName,
        event.args,
        repoRoot !== undefined ? { repoRoot } : undefined,
      );
    }
    case "agent_end":
      return "Agent turn completed";
    case "tool":
      if (event.isError) {
        const reason = formatFlueError(event.result) ?? "Tool failed";
        return redact(`tool_failed: ${event.toolName}: ${reason}`);
      }
      return undefined;
    case "log":
      return `${event.level}: ${event.message}`;
    default:
      return undefined;
  }
}

async function resolveRepoRootForInstance(
  instanceId: string,
  bridge: ObserveBridgeCallbacks,
): Promise<string | undefined> {
  if (isThreadcordInstance(instanceId)) {
    const task = await bridge.store.getByInstanceId(instanceId);
    return task ? checkoutPathForTask(task) : undefined;
  }
  if (instanceId.startsWith("setup:") && bridge.setupStore) {
    const run = await bridge.setupStore.getRunByInstanceId(instanceId);
    if (!run) return undefined;
    return posix.join(run.workspacePath, posix.basename(run.repo));
  }
  return undefined;
}

function resolveMaxToolFailuresForObserve(): number {
  try {
    return resolveAgentMaxToolFailures(getRuntimeConfig());
  } catch {
    return DEFAULT_AGENT_MAX_TOOL_FAILURES;
  }
}

export function failureDiscordMessage(errorSummary: string): string {
  const summary = summarizeError(new Error(errorSummary));
  if (/Stopped after \d+ consecutive tool failures/i.test(summary)) {
    return `Failed: ${summary} The agent was stopped to avoid a retry loop. Fix the underlying tool issue and send a new message in this thread.`;
  }
  if (/finish_reason/i.test(summary)) {
    return `Failed: ${summary}. The model provider stream ended before completion. This turn was not replayed.`;
  }
  return `Failed: ${summary}. This turn was not replayed automatically.`;
}
