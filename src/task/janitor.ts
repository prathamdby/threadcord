import { rm } from "node:fs/promises";
import { summarizeError } from "../util/redact.js";
import type { TaskStore } from "./store.js";
import type { TurnStore } from "./turn-store.js";

const TURN_BATCH_SIZE = 5000;

type JanitorArgs = {
  store: TaskStore;
  workspaceTtlDays: number;
  turnStore?: TurnStore;
  turnRetentionDays?: number;
};

function runCleanup(args: JanitorArgs): void {
  void cleanup(args).catch((error) => {
    console.error(
      "[threadcord] workspace janitor failed:",
      summarizeError(error),
    );
  });
}

export function startWorkspaceJanitor(args: {
  store: TaskStore;
  workspaceTtlDays: number;
  turnStore?: TurnStore;
  turnRetentionDays?: number;
  intervalMs?: number;
}): NodeJS.Timeout {
  const interval = setInterval(
    () => {
      runCleanup(args);
    },
    args.intervalMs ?? 6 * 60 * 60 * 1000,
  );
  runCleanup(args);
  return interval;
}

export async function cleanup(args: {
  store: TaskStore;
  workspaceTtlDays: number;
  turnStore?: TurnStore;
  turnRetentionDays?: number;
}): Promise<void> {
  const paths = await args.store.listExpiredWorkspacePaths(args.workspaceTtlDays);
  for (const workspacePath of paths) {
    await rm(workspacePath, { recursive: true, force: true });
  }

  // Retain terminal turn rows: batch-delete aged rows until a batch returns
  // fewer than TURN_BATCH_SIZE (meaning no more rows qualify).
  if (args.turnStore && args.turnRetentionDays !== undefined) {
    let deleted = TURN_BATCH_SIZE;
    while (deleted >= TURN_BATCH_SIZE) {
      deleted = await args.turnStore.deleteAgedTerminalTurns(
        args.turnRetentionDays,
        TURN_BATCH_SIZE,
      );
    }
  }
}
