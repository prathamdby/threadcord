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

interface NamerHandle {
  title: Promise<string>;
  ready: Promise<void>;
  dispose: () => void;
}

/** Subscribe before dispatch so early namer events are not missed. */
function waitForNamerTitle(instanceId: string): NamerHandle {
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let stopObserve: (() => void) | undefined;

  let settle!: (
    outcome: { ok: true; title: string } | { ok: false; error: Error },
  ) => void;

  // The title promise is created with an immediately-attached .catch so that
  // a timeout or failure rejection never surfaces as an unhandled rejection
  // if it fires before the caller awaits it. The caller still awaits
  // titlePromise inside a try/catch; this early handler is the safety net.
  let titleResolve!: (value: string) => void;
  let titleReject!: (error: Error) => void;
  const title = new Promise<string>((resolve, reject) => {
    titleResolve = resolve;
    titleReject = reject;
  });
  // Attach an immediate no-op catch to prevent unhandled rejection.
  title.catch(() => {});

  settle = (outcome) => {
    stopObserve?.();
    stopObserve = undefined;
    if (outcome.ok) titleResolve(outcome.title);
    else titleReject(outcome.error);
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

  const timeout = setTimeout(() => {
    settle({ ok: false, error: new Error("Thread namer observe timed out") });
  }, NAMER_OBSERVE_TIMEOUT_MS);
  if (typeof timeout.unref === "function") timeout.unref();

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
 *
 * All failure paths (timeout, dispatch rejection, empty title, rename
 * rejection) are caught and logged. No unhandled promise rejection can escape.
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
    const { title: titlePromise, ready, dispose } =
      waitForNamerTitle(instanceId);
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
