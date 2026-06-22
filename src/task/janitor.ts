import { rm } from 'node:fs/promises';
import type { TaskStore } from './store.js';

export function startWorkspaceJanitor(args: {
  store: TaskStore;
  workspaceTtlDays: number;
  intervalMs?: number;
}): NodeJS.Timeout {
  const interval = setInterval(() => {
    void cleanup(args.store, args.workspaceTtlDays);
  }, args.intervalMs ?? 6 * 60 * 60 * 1000);
  void cleanup(args.store, args.workspaceTtlDays);
  return interval;
}

async function cleanup(store: TaskStore, ttlDays: number): Promise<void> {
  const paths = await store.listExpiredWorkspacePaths(ttlDays);
  for (const workspacePath of paths) {
    await rm(workspacePath, { recursive: true, force: true });
  }
}
