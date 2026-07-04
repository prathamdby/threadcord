import { createSessionStorageKey } from "@flue/runtime/adapter";
import type { AgentExecutionStore } from "@flue/runtime/internal";

let executionStore: AgentExecutionStore | undefined;

type CoordinatorAbort = (
  instanceId: string,
  reason?: DOMException,
) => Promise<number>;

let coordinatorAbort: CoordinatorAbort | undefined;

const operatorAbortedInstances = new Set<string>();

declare global {
  var __threadcordRegisterFlueCoordinator:
    | ((coordinator: {
        abortInstance?: CoordinatorAbort;
      }) => void)
    | undefined;
}

globalThis.__threadcordRegisterFlueCoordinator = (coordinator) => {
  if (typeof coordinator.abortInstance === "function") {
    coordinatorAbort = coordinator.abortInstance.bind(coordinator);
  }
};

export function registerFlueExecutionStore(store: AgentExecutionStore): void {
  executionStore = store;
}

export function markOperatorAborted(instanceId: string): void {
  operatorAbortedInstances.add(instanceId);
}

export function isOperatorAborted(instanceId: string): boolean {
  return operatorAbortedInstances.has(instanceId);
}

export function clearOperatorAborted(instanceId: string): void {
  operatorAbortedInstances.delete(instanceId);
}

/** Test-only: reset in-memory abort state. */
export function resetOperatorAbortStateForTests(): void {
  operatorAbortedInstances.clear();
  coordinatorAbort = undefined;
}

/** Fail every in-flight Flue submission for this task/setup instance. */
export async function abortAgentWorkForInstance(
  instanceId: string,
): Promise<number> {
  const submissions = executionStore?.submissions;
  if (!submissions) return 0;

  markOperatorAborted(instanceId);

  const reason = new DOMException(
    "Aborted by operator via thread command.",
    "AbortError",
  );
  let stopped = 0;

  if (coordinatorAbort) {
    try {
      stopped += await coordinatorAbort(instanceId, reason);
    } catch (error) {
      console.error("[threadcord] coordinator abort failed", error);
    }
  }

  const sessionKey = sessionKeyForInstance(instanceId);

  for (const submission of await submissions.listRunningSubmissions()) {
    if (submission.sessionKey !== sessionKey) continue;
    if (!submission.attemptId) continue;
    const failed = await submissions.failSubmission(
      {
        submissionId: submission.submissionId,
        attemptId: submission.attemptId,
      },
      reason,
    );
    if (failed) stopped += 1;
  }

  return stopped;
}

export function sessionKeyForInstance(instanceId: string): string {
  return createSessionStorageKey(instanceId, "default", "default");
}