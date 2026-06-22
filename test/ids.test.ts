import { describe, expect, it } from "vitest";
import {
  isThreadcordInstance,
  parseDiscordThreadId,
  pendingThreadId,
  toFlueInstanceId,
} from "../src/ids.js";

describe("threadcord instance ids", () => {
  it("round-trips discord thread ids", () => {
    const threadId = "1234567890";
    const instanceId = toFlueInstanceId(threadId);

    expect(isThreadcordInstance(instanceId)).toBe(true);
    expect(parseDiscordThreadId(instanceId)).toBe(threadId);
  });

  it("marks pending thread placeholders", () => {
    expect(pendingThreadId("task-1")).toBe("pending:task-1");
  });
});
