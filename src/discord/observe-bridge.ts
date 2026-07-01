import { isThreadcordInstance } from "../ids.js";
import {
  setupProgressSessionFromRun,
  type SetupProgressSession,
} from "../setup/progress-session.js";
import type { SetupStore } from "../setup/store.js";
import type { TaskStore } from "../task/store.js";
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

export const PROGRESS_EDIT_INTERVAL_MS = 1500;

export interface ObserveBridgeCallbacks {
  store: TaskStore;
  setupStore?: SetupStore;
  publisher: DiscordPublisher;
  onAgentEnd: (instanceId: string) => Promise<void>;
  onAgentFailure: (instanceId: string, errorSummary: string) => Promise<void>;
}

interface PendingToolStart {
  toolName: string;
  args: unknown;
}

export interface ObserveBridgeState {
  renderState: Map<string, InstanceRenderState>;
  timers: Map<string, NodeJS.Timeout>;
  instanceChains: Map<string, Promise<void>>;
  pendingToolStarts: Map<string, PendingToolStart>;
}

export interface BridgeProgressLine {
  line: string;
  terminal: boolean;
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

export async function renderProgressLine(
  instanceId: string,
  summary: BridgeProgressLine,
  args: ObserveBridgeCallbacks,
  state: ObserveBridgeState,
): Promise<void> {
  const inst = state.renderState.get(instanceId) ?? newInstanceRenderState();
  const outcome = appendRenderedLine(inst, summary.line, summary.terminal);
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

export async function resolveProgressStream(
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

export { flushProgressMessage, shouldRollBubble } from "./progress-stream.js";

const GENERIC_AGENT_FAILURE_MESSAGE =
  "The agent encountered an error during this turn. The turn was not replayed automatically. Details have been logged.";

export function failureDiscordMessage(_errorSummary: string): string {
  return GENERIC_AGENT_FAILURE_MESSAGE;
}
