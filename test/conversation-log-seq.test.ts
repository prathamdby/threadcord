import { describe, expect, it } from "vitest";
import { DurableConversationLog } from "../src/agentturn/conversation-log.js";
import { InMemoryConversationLogStore } from "./support/conversation-log-store.js";

describe("ConversationLog sequence allocation", () => {
  it("assigns distinct seq values under concurrent appends", async () => {
    const log = new DurableConversationLog(new InMemoryConversationLogStore());
    const sessionId = "discord:thread:thread-1";
    const turnId = "turn-1";

    const records = await Promise.all([
      log.append({
        session_id: sessionId,
        turn_id: turnId,
        attempt_id: "attempt-a",
        event_kind: "text_delta",
        payload: { delta: "a" },
      }),
      log.append({
        session_id: sessionId,
        turn_id: turnId,
        attempt_id: "attempt-b",
        event_kind: "text_delta",
        payload: { delta: "b" },
      }),
    ]);

    const seqs = records.map((record) => record.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2]);
  });
});
