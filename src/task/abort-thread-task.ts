import { clearPendingUserTurnMessage } from "../discord/user-turn-message.js";
import { abortAgentWorkForInstance } from "../flue/agent-work-abort.js";
import { releaseTaskSingleton } from "./boss.js";
import { resolveTurnOutcome } from "./turn-completion.js";
import type { TaskStore } from "./store.js";
import type { TurnStore } from "./turn-store.js";
import type { PgBoss } from "pg-boss";
import type { TaskRecord } from "../types.js";

type ReactionTarget = {
  react(emoji: string): Promise<void>;
  unreact(emoji: string): Promise<void>;
};

export interface AbortThreadTaskDeps {
  store: TaskStore;
  turnStore: TurnStore;
  boss: PgBoss;
  clearInFlight: (
    instanceId: string,
  ) => { initiator?: ReactionTarget | undefined } | undefined;
  flipReaction: (
    initiator: ReactionTarget | undefined,
    emoji: string,
  ) => Promise<void>;
  disposeInitiators: (taskId: string, emoji: string) => Promise<void>;
  deleteTaskThread: (instanceId: string) => void;
}

export interface StopTaskWorkOptions {
  /** When true, fail in-flight Flue submissions for this instance (`abort`). */
  abortInFlight?: boolean;
}

export async function stopTaskWork(
  task: TaskRecord,
  deps: AbortThreadTaskDeps,
  options: StopTaskWorkOptions = {},
): Promise<{ cancelled: boolean; alreadyTerminal: boolean }> {
  const cancelled = await deps.store.cancelTask(task.id);
  if (!cancelled) {
    return { cancelled: false, alreadyTerminal: true };
  }

  // Gate the turn rows: request cancel on any running turn and cancel queued
  // turns so they cannot fire after this point.
  const runningTurns = await deps.turnStore.listRunningTurns();
  for (const turn of runningTurns) {
    if (turn.taskId === task.id) {
      await deps.turnStore.requestCancel(turn.id);
    }
  }
  await deps.turnStore.cancelPendingTurnsForTask(task.id);

  // Cancel the queued/active pg-boss jobs for this task's singleton key.
  await releaseTaskSingleton(deps.boss, task.id);

  // Abort the Flue submission FIRST, then resolve the turn outcome cancelled.
  // Order matters: abort kills the Flue submission so its late agent_end is
  // suppressed; resolving first would let the executor settle while Flue
  // still runs.
  if (options.abortInFlight) {
    try {
      await abortAgentWorkForInstance(task.flueInstanceId);
    } catch (error) {
      console.error("[threadcord] failed to abort agent work", error);
    }
    resolveTurnOutcome(task.flueInstanceId, { kind: "cancelled" });
  }

  clearPendingUserTurnMessage(task.flueInstanceId);
  const turn = deps.clearInFlight(task.flueInstanceId);
  await deps.flipReaction(turn?.initiator, "❌");
  await deps.disposeInitiators(task.id, "❌");
  deps.deleteTaskThread(task.flueInstanceId);

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
