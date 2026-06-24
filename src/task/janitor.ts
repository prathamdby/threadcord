import { rm } from "node:fs/promises";
import { redact } from "../util/redact.js";
import { decideWorkspaceDeletion } from "./workspace.js";

export interface WorkspaceJanitorStore {
  listExpiredWorkspacePaths(ttlDays: number): Promise<string[]>;
}

export function startWorkspaceJanitor(args: {
  store: WorkspaceJanitorStore;
  workspaceRoot: string;
  workspaceTtlDays: number;
  intervalMs?: number;
}): NodeJS.Timeout {
  const interval = setInterval(
    () => {
      void cleanupExpiredWorkspaces(
        args.store,
        args.workspaceRoot,
        args.workspaceTtlDays,
      );
    },
    args.intervalMs ?? 6 * 60 * 60 * 1000,
  );
  void cleanupExpiredWorkspaces(
    args.store,
    args.workspaceRoot,
    args.workspaceTtlDays,
  );
  return interval;
}

export async function cleanupExpiredWorkspaces(
  store: WorkspaceJanitorStore,
  workspaceRoot: string,
  ttlDays: number,
  options?: { warn?: (message: string) => void },
): Promise<void> {
  const warn = options?.warn ?? ((message: string) => console.warn(message));
  const paths = await store.listExpiredWorkspacePaths(ttlDays);
  for (const workspacePath of paths) {
    const decision = await decideWorkspaceDeletion(workspacePath, workspaceRoot);
    if (decision.action === "skip") {
      warn(
        redact(
          `[threadcord] skipped workspace cleanup for ${workspacePath}: ${decision.reason}`,
        ),
      );
      continue;
    }
    await rm(decision.resolvedPath, { recursive: true, force: true });
  }
}