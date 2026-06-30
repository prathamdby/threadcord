import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_KINDS,
  DurableConversationLog,
  type AgentEventRecord,
  type ConversationLog,
  type ConversationLogEventInput,
  redactPayload,
} from "../src/agentturn/conversation-log.js";
import { InMemoryConversationLogStore } from "./support/conversation-log-store.js";

const sessionId = "session-1";
const turnId = "turn-1";
const attemptId = "attempt-1";

function createLog(): { log: ConversationLog; store: InMemoryConversationLogStore } {
  const store = new InMemoryConversationLogStore();
  const log = new DurableConversationLog(store);
  return { log, store };
}

function eventInput(kind: AgentEventRecord["event_kind"], payload: unknown): ConversationLogEventInput {
  return {
    session_id: sessionId,
    turn_id: turnId,
    attempt_id: attemptId,
    event_kind: kind,
    payload,
  };
}

describe("ConversationLog", () => {
  it("appends an event with seq and attempt_seq", async () => {
    const { log } = createLog();

    const record = await log.append(eventInput("text_delta", { delta: "hello" }));

    expect(record).toMatchObject({
      session_id: sessionId,
      turn_id: turnId,
      attempt_id: attemptId,
      seq: 1,
      attempt_seq: 1,
      event_kind: "text_delta",
      payload: { delta: "hello" },
      superseded: false,
    });
    expect(record.id).toBeGreaterThan(0);
    expect(record.created_at).toBeInstanceOf(Date);
  });

  it("seq increments across events in the same session and attempt", async () => {
    const { log } = createLog();

    const first = await log.append(eventInput("text_delta", { delta: "a" }));
    const second = await log.append(eventInput("text_delta", { delta: "b" }));
    const third = await log.append(eventInput("tool_start", { toolName: "read" }));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(third.seq).toBe(3);
    expect(first.attempt_seq).toBe(1);
    expect(second.attempt_seq).toBe(2);
    expect(third.attempt_seq).toBe(3);
  });

  it("attempt_seq resets for a new attempt while seq continues across the session", async () => {
    const { log } = createLog();

    const a1 = await log.append(eventInput("text_delta", { delta: "a" }));
    const a2 = await log.append({
      ...eventInput("text_delta", { delta: "b" }),
      attempt_id: "attempt-2",
    });
    const a3 = await log.append({
      ...eventInput("text_delta", { delta: "c" }),
      attempt_id: "attempt-3",
    });

    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(a3.seq).toBe(3);
    expect(a1.attempt_seq).toBe(1);
    expect(a2.attempt_seq).toBe(1);
    expect(a3.attempt_seq).toBe(1);
  });

  it("seq continues across turns in the same session", async () => {
    const { log } = createLog();

    const first = await log.append(eventInput("text_delta", { delta: "a" }));
    const second = await log.append({
      ...eventInput("text_delta", { delta: "b" }),
      turn_id: "turn-2",
      attempt_id: "attempt-2",
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it("marks all events from a single attempt as superseded", async () => {
    const { log, store } = createLog();

    const a1 = await log.append(eventInput("text_delta", { delta: "a" }));
    const a2 = await log.append(eventInput("text_delta", { delta: "b" }));
    await log.append({
      ...eventInput("text_delta", { delta: "c" }),
      attempt_id: "attempt-2",
    });

    const count = await log.markSuperseded(attemptId);
    expect(count).toBe(2);

    const after = await store.listByAttemptId(attemptId);
    expect(after.every((event) => event.superseded)).toBe(true);
    expect(after.map((event) => event.id)).toContain(a1.id);
    expect(after.map((event) => event.id)).toContain(a2.id);
  });

  it("supersession does not affect events from other attempts", async () => {
    const { log, store } = createLog();

    await log.append(eventInput("text_delta", { delta: "a" }));
    const other = await log.append({
      ...eventInput("text_delta", { delta: "b" }),
      attempt_id: "attempt-2",
    });

    await log.markSuperseded(attemptId);

    const otherEvents = await store.listByAttemptId("attempt-2");
    expect(otherEvents).toHaveLength(1);
    expect(otherEvents[0]?.superseded).toBe(false);
    expect(otherEvents[0]?.id).toBe(other.id);
  });

  it("supersession does not affect events from other turns in the same session", async () => {
    const { log, store } = createLog();

    await log.append(eventInput("text_delta", { delta: "a" }));
    const other = await log.append({
      ...eventInput("text_delta", { delta: "b" }),
      turn_id: "turn-2",
      attempt_id: "attempt-2",
    });

    await log.markSuperseded(attemptId);

    const otherEvents = await store.listByAttemptId("attempt-2");
    expect(otherEvents).toHaveLength(1);
    expect(otherEvents[0]?.superseded).toBe(false);
    expect(otherEvents[0]?.id).toBe(other.id);
  });

  it("rebuildTranscript excludes superseded events", async () => {
    const { log } = createLog();

    const a1 = await log.append(eventInput("text_delta", { delta: "stale" }));
    const a2 = await log.append({
      ...eventInput("text_delta", { delta: "canonical" }),
      attempt_id: "attempt-2",
    });

    await log.markSuperseded(attemptId);

    const transcript = await log.rebuildTranscript(sessionId);
    expect(transcript.map((event) => event.id)).toEqual([a2.id]);
  });

  it("rebuildTranscript retains milestone events from superseded attempts", async () => {
    const { log } = createLog();

    const stale = await log.append(eventInput("text_delta", { delta: "stale" }));
    const milestone = await log.append(eventInput("turn_failed", { reason: "attempt interrupted" }));
    const canonical = await log.append({
      ...eventInput("text_delta", { delta: "canonical" }),
      attempt_id: "attempt-2",
    });

    await log.markSuperseded(attemptId);

    const transcript = await log.rebuildTranscript(sessionId);
    expect(transcript.map((event) => event.id)).toEqual([milestone.id, canonical.id]);
    expect(transcript[0]?.event_kind).toBe("turn_failed");
  });

  it("projectForDiscord returns canonical events ordered by seq", async () => {
    const { log } = createLog();

    const a1 = await log.append(eventInput("text_delta", { delta: "a" }));
    const a2 = await log.append(eventInput("text_delta", { delta: "b" }));

    const projection = await log.projectForDiscord(sessionId);
    expect(projection.map((event) => event.id)).toEqual([a1.id, a2.id]);
    expect(projection.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("redacts secrets in the payload before storage", async () => {
    const { log, store } = createLog();
    const secret = "ghp_aBcDeFgHiJkLmNoPqRsTuvw";

    await log.append(eventInput("text_delta", { delta: `auth ${secret}` }));

    const events = await store.listBySessionId(sessionId);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { delta: string };
    expect(payload.delta).toContain("[redacted]");
    expect(payload.delta).not.toContain(secret);
  });

  it("redacts nested secrets in the payload", async () => {
    const { log, store } = createLog();
    const secret = "sk-1234567890abcdef";

    await log.append(
      eventInput("tool_start", {
        config: { apiKey: secret, nested: { token: secret } },
      }),
    );

    const events = await store.listBySessionId(sessionId);
    const payload = events[0]?.payload as {
      config: { apiKey: string; nested: { token: string } };
    };
    expect(payload.config.apiKey).toBe("[redacted]");
    expect(payload.config.nested.token).toBe("[redacted]");
  });

  it("rejects an unknown event kind", async () => {
    const { log } = createLog();

    await expect(
      log.append({
        session_id: sessionId,
        turn_id: turnId,
        attempt_id: attemptId,
        event_kind: "not_a_kind" as AgentEventRecord["event_kind"],
        payload: {},
      }),
    ).rejects.toThrow("Unknown agent event kind: not_a_kind");
  });

  it("does not delete events when marking superseded", async () => {
    const { log, store } = createLog();

    const a1 = await log.append(eventInput("text_delta", { delta: "a" }));
    await log.markSuperseded(attemptId);

    const all = await store.listBySessionId(sessionId);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(a1.id);
    expect(all[0]?.superseded).toBe(true);
  });

  it("redactPayload leaves non-secret payloads unchanged", () => {
    expect(redactPayload({ message: "hello", count: 3 })).toEqual({
      message: "hello",
      count: 3,
    });
  });

  it("canonical set equals non-superseded rows plus retained milestones", async () => {
    const { log, store } = createLog();

    const normal = await log.append(eventInput("text_delta", { delta: "a" }));
    const milestone = await log.append(eventInput("turn_failed", { reason: "boom" }));
    await log.markSuperseded(attemptId);
    const fresh = await log.append({
      ...eventInput("text_delta", { delta: "b" }),
      attempt_id: "attempt-2",
    });

    const projection = await log.projectForDiscord(sessionId);
    const rows = await store.listBySessionId(sessionId);
    const nonSuperseded = rows.filter((event) => !event.superseded);
    const retainedMilestones = rows.filter(
      (event) => event.superseded && ["turn_failed", "turn_cancelled", "environment_issue"].includes(event.event_kind),
    );

    expect(projection.map((event) => event.id)).toEqual([
      ...retainedMilestones.map((event) => event.id),
      fresh.id,
    ]);
    expect(projection.map((event) => event.id)).not.toContain(normal.id);
    expect(nonSuperseded).toHaveLength(1);
  });
});
