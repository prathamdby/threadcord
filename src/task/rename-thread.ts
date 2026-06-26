import { randomUUID } from "node:crypto";
import { observe } from "@flue/runtime";
import { dispatch } from "@flue/runtime";
import threadNamerAgent, {
  type ThreadNamerInput,
} from "../agents/thread-namer.js";
import { submissionFailureSummary } from "../discord/observe-bridge.js";
import { sanitizeDiscordThreadName } from "./thread-name.js";

export type RenameDiscordThread = (
  threadId: string,
  name: string,
) => Promise<void>;

/** Flue instance id prefix for one-off thread rename dispatches. */
export const THREAD_NAMER_INSTANCE_PREFIX = "threadcord:namer:" as const;

function namerInstanceId(): string {
  return `${THREAD_NAMER_INSTANCE_PREFIX}${randomUUID()}`;
}

const NAMER_OBSERVE_TIMEOUT_MS = 120_000;

/** Subscribe before dispatch so early namer events are not missed. */
function waitForNamerTitle(instanceId: string): {
  title: Promise<string>;
  ready: Promise<void>;
  dispose: () => void;
} {
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let stopObserve: (() => void) | undefined;
  let settle!: (
    outcome: { ok: true; title: string } | { ok: false; error: Error },
  ) => void;

  const title = new Promise<string>((resolve, reject) => {
    let settled = false;
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      stopObserve?.();
      stopObserve = undefined;
      if (outcome.ok) resolve(outcome.title);
      else reject(outcome.error);
    };
    const chunks: string[] = [];
    stopObserve = observe((event) => {
      if (!("instanceId" in event) || event.instanceId !== instanceId) return;
      if (event.type === "text_delta" && typeof event.text === "string") {
        chunks.push(event.text);
      }
      if (event.type === "agent_end") {
        settle({ ok: true, title: chunks.join("").trim() });
        return;
      }
      const summary = submissionFailureSummary(event);
      if (summary) {
        settle({ ok: false, error: new Error(summary) });
      }
    });
    readyResolve();
  });

  const timeout = setTimeout(() => {
    settle({ ok: false, error: new Error("Thread namer observe timed out") });
  }, NAMER_OBSERVE_TIMEOUT_MS);
  if (typeof timeout.unref === "function") timeout.unref();

  void title.finally(() => clearTimeout(timeout));

  return {
    title,
    ready,
    dispose: () => {
      clearTimeout(timeout);
      stopObserve?.();
      stopObserve = undefined;
    },
  };
}

/**
 * Dispatches a small naming agent in parallel with the main coding turn, then
 * renames the Discord thread when the namer finishes.
 */
export function scheduleReadableThreadRename(
  threadId: string,
  taskInstruction: string,
  renameThread: RenameDiscordThread,
): void {
  void (async () => {
    const instruction = taskInstruction.trim();
    if (!instruction) return;

    const instanceId = namerInstanceId();
    const input: ThreadNamerInput = { instruction };
    const {
      title: titlePromise,
      ready,
      dispose,
    } = waitForNamerTitle(instanceId);
    try {
      await ready;
      await dispatch(threadNamerAgent, { id: instanceId, input });
      const title = await titlePromise;
      if (!title) return;
      await renameThread(threadId, sanitizeDiscordThreadName(title));
    } catch (error) {
      console.error("[threadcord] thread rename failed", error);
    } finally {
      dispose();
    }
  })();
}
