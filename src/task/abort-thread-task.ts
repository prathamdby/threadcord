import { clearPendingUserTurnMessage } from "../discord/user-turn-message.js";
import { abortAgentWorkForInstance } from "../flue/agent-work-abort.js";
import type { TaskStore } from "./store.js";
import type { TaskRecord } from "../types.js";

type ReactionTarget = {
  react(emoji: string): Promise<void>;
  unreact(emoji: string): Promise<void>;
};

export interface AbortThreadTaskDeps {
  store: TaskStore;
  clearInFlight: (instanceId: string) =>
    | { initiator?: ReactionTarget | undefined }
    | undefined;
  flipReaction: (
    initiator: ReactionTarget | undefined,
    emoji: string,
  ) => Promise<void>;
  disposeInitiators: (taskId: string, emoji: string) => Promise<void>;
  deleteTaskThread: (instanceId: string) => void;
  fillConcurrencySlots: () => Promise<void>;
}

export async function stopTaskWork(
  task: TaskRecord,
  deps: AbortThreadTaskDeps,
): Promise<{ cancelled: boolean; alreadyTerminal: boolean }> {
  const cancelled = await deps.store.cancelTask(task.id);
  if (!cancelled) {
    return { cancelled: false, alreadyTerminal: true };
  }

  clearPendingUserTurnMessage(task.flueInstanceId);
  await abortAgentWorkForInstance(task.flueInstanceId);

  const turn = deps.clearInFlight(task.flueInstanceId);
  await deps.flipReaction(turn?.initiator, "❌");
  await deps.disposeInitiators(task.id, "❌");
  deps.deleteTaskThread(task.flueInstanceId);
  await deps.fillConcurrencySlots();

  return { cancelled: true, alreadyTerminal: false };
}

export function parseThreadControlCommand(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "/abort" || trimmed === "abort") return "abort";
  if (trimmed === "/cancel" || trimmed === "cancel") return "cancel";
  if (trimmed === "status") return "status";
  if (trimmed === "done") return "done";
  return trimmed;
}