import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortAgentWorkForInstance,
  isOperatorAborted,
  markOperatorAborted,
  registerFlueExecutionStore,
  resetOperatorAbortStateForTests,
  sessionKeyForInstance,
} from "../src/flue/agent-work-abort.js";

beforeEach(() => {
  resetOperatorAbortStateForTests();
});

describe("abortAgentWorkForInstance", () => {
  it("signals the coordinator before failing durable submissions", async () => {
    const coordinatorAbort = vi.fn(
      async (_instanceId: string, _reason?: DOMException) => 1,
    );
    globalThis.__threadcordRegisterFlueCoordinator?.({
      abortInstance: coordinatorAbort,
    });

    const failSubmission = vi.fn(async () => true);
    registerFlueExecutionStore({
      sessions: {} as never,
      submissions: {
        listRunningSubmissions: async () => [
          {
            submissionId: "sub-1",
            sessionKey: sessionKeyForInstance("discord:thread:thread-1"),
            attemptId: "attempt-1",
          },
        ],
        failSubmission,
      } as never,
    });

    const stopped = await abortAgentWorkForInstance("discord:thread:thread-1");

    expect(coordinatorAbort).toHaveBeenCalledTimes(1);
    const [instanceArg, reasonArg] = coordinatorAbort.mock.calls[0] ?? [];
    expect(instanceArg).toBe("discord:thread:thread-1");
    expect(reasonArg).toMatchObject({
      name: "AbortError",
    });
    expect(failSubmission).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(2);
    expect(isOperatorAborted("discord:thread:thread-1")).toBe(true);
  });

  it("marks the instance aborted even when no execution store is registered", async () => {
    const stopped = await abortAgentWorkForInstance("discord:thread:orphan");
    expect(stopped).toBe(0);
    expect(isOperatorAborted("discord:thread:orphan")).toBe(true);
  });
});

describe("operator abort marker", () => {
  it("tracks and clears operator abort state", () => {
    markOperatorAborted("discord:thread:thread-2");
    expect(isOperatorAborted("discord:thread:thread-2")).toBe(true);
    resetOperatorAbortStateForTests();
    expect(isOperatorAborted("discord:thread:thread-2")).toBe(false);
  });
});