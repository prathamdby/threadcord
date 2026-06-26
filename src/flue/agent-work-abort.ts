import { createSessionStorageKey } from "@flue/runtime/adapter";
import type { AgentExecutionStore } from "@flue/runtime/internal";

const TASK_AGENT_NAMES = ["coding", "setup"] as const;

let executionStore: AgentExecutionStore | undefined;

export function registerFlueExecutionStore(store: AgentExecutionStore): void {
  executionStore = store;
}

/** Fail every in-flight Flue submission for this task/setup instance. */
export async function abortAgentWorkForInstance(
  instanceId: string,
): Promise<number> {
  const submissions = executionStore?.submissions;
  if (!submissions) return 0;

  const reason = new DOMException(
    "Aborted by operator via thread command.",
    "AbortError",
  );
  let stopped = 0;

  for (const submission of await submissions.listRunningSubmissions()) {
    const input = submission.input;
    if (!input || input.id !== instanceId) continue;
    if (
      !TASK_AGENT_NAMES.includes(
        input.agent as (typeof TASK_AGENT_NAMES)[number],
      )
    ) {
      continue;
    }
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