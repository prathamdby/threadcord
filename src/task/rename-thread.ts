import {
  createHostThreadNamer,
  type RenameDiscordThread,
} from "../agentturn/index.js";
import type { Logger } from "../agentturn/host-thread-namer.js";

export type { RenameDiscordThread } from "../agentturn/index.js";

/** Legacy prefix kept for existing tests; host-side namer no longer uses it. */
export const THREAD_NAMER_INSTANCE_PREFIX = "threadcord:namer:" as const;

function defaultThreadRenameLogger(): Logger {
  return {
    log(level, message, meta) {
      const entry = meta ? { level, message, meta } : { level, message };
      if (level === "error" || level === "warn") {
        console.error("[threadcord]", entry);
      } else {
        console.log("[threadcord]", entry);
      }
    },
  };
}

/**
 * Schedules a readable thread rename in the background using a lightweight,
 * host-side AgentTurn session with role "thread-namer". No Flue dispatch is
 * used. The rename is best-effort: failures are logged and the task continues.
 *
 * All failure paths (timeout, empty/whitespace instruction, rename rejection)
 * are caught and logged. No unhandled promise rejection can escape.
 */
export function scheduleReadableThreadRename(
  threadId: string,
  taskInstruction: string,
  model: string,
  renameThread: RenameDiscordThread,
  logger?: Logger,
): void {
  void (async () => {
    const instruction = taskInstruction.trim();
    if (!instruction) return;

    const namer = createHostThreadNamer({
      defaultModel: model,
      renameThread,
      timeoutMs: 90_000,
      maxAttempts: 2,
      logger: logger ?? defaultThreadRenameLogger(),
    });

    try {
      const result = await namer.prompt({
        instanceId: `discord:thread:${threadId}`,
        role: "thread-namer",
        instruction,
        model,
        workspacePath: "",
        repo: "",
        baseBranch: "",
        setupProfileRevision: 0,
      });
      if (!result.accepted) {
        console.error("[threadcord] thread namer rejected:", result.reason);
      }
    } catch (error) {
      console.error("[threadcord] thread rename failed", error);
    }
  })();
}
