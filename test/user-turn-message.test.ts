import { describe, expect, it } from "vitest";
import {
  clearPendingUserTurnMessage,
  hasPendingUserTurnMessages,
  queuePendingUserTurnMessages,
  setPendingUserTurnMessage,
  takePendingUserTurnMessage,
  takePendingUserTurnMessages,
} from "../src/discord/user-turn-message.js";

describe("user turn message queue", () => {
  it("stores and takes a single message once", () => {
    setPendingUserTurnMessage("discord:thread:1", "  Hello user  ");
    expect(takePendingUserTurnMessages("discord:thread:1")).toEqual([
      "Hello user",
    ]);
    expect(takePendingUserTurnMessages("discord:thread:1")).toEqual([]);
  });

  it("keeps takePendingUserTurnMessage as a joined compatibility wrapper", () => {
    queuePendingUserTurnMessages("discord:thread:1b", ["Part one", "Part two"]);
    expect(takePendingUserTurnMessage("discord:thread:1b")).toBe(
      "Part one\n\nPart two",
    );
  });

  it("queues multiple parts atomically", () => {
    queuePendingUserTurnMessages("discord:thread:2", [
      "  Section A  ",
      "Section B",
    ]);
    expect(takePendingUserTurnMessages("discord:thread:2")).toEqual([
      "Section A",
      "Section B",
    ]);
  });

  it("rejects empty multi-part queues", () => {
    expect(() =>
      queuePendingUserTurnMessages("discord:thread:3", ["   "]),
    ).toThrow(/non-empty/i);
  });

  it("rejects mixing post_thread_message and post_thread_report", () => {
    setPendingUserTurnMessage("discord:thread:4", "Already queued");
    expect(() =>
      queuePendingUserTurnMessages("discord:thread:4", ["Part two"]),
    ).toThrow(/already has a queued report/i);
    expect(() =>
      setPendingUserTurnMessage("discord:thread:4", "Another one"),
    ).toThrow(/already has a queued report/i);
  });

  it("ignores blank single messages", () => {
    setPendingUserTurnMessage("discord:thread:5", "   ");
    expect(hasPendingUserTurnMessages("discord:thread:5")).toBe(false);
  });

  it("clears without posting", () => {
    queuePendingUserTurnMessages("discord:thread:6", ["bye"]);
    clearPendingUserTurnMessage("discord:thread:6");
    expect(takePendingUserTurnMessages("discord:thread:6")).toEqual([]);
  });
});
