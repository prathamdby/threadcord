import { redact } from "../util/redact.js";

/**
 * Event kinds stored in the append-only `agent_events` table. Each kind
 * represents one observable step in an agent session.
 */
export type AgentEventKind =
  | "text_delta"
  | "tool_start"
  | "tool_result"
  | "tool_failure"
  | "agent_message"
  | "permission_failure"
  | "final_output"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "environment_issue";

export const AGENT_EVENT_KINDS: readonly AgentEventKind[] = [
  "text_delta",
  "tool_start",
  "tool_result",
  "tool_failure",
  "agent_message",
  "permission_failure",
  "final_output",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "environment_issue",
];

/**
 * Postgres row shape for `agent_events`. The event log is append-only: rows are
 * never deleted; superseded events are flagged with `superseded=true`.
 */
export interface AgentEventRecord {
  id: number;
  session_id: string;
  turn_id: string;
  attempt_id: string;
  seq: number;
  attempt_seq: number;
  event_kind: AgentEventKind;
  payload: unknown;
  superseded: boolean;
  created_at: Date;
}

/**
 * Input required to append a new event. The caller supplies the session, turn,
 * and attempt identifiers; ConversationLog assigns the sequence numbers and
 * persists the row.
 */
export interface ConversationLogEventInput {
  session_id: string;
  turn_id: string;
  attempt_id: string;
  event_kind: AgentEventKind;
  payload: unknown;
}

/**
 * Store interface for `agent_events`. The real implementation is Postgres;
 * unit tests use an in-memory fake.
 */
export interface ConversationLogStore {
  insert(record: Omit<AgentEventRecord, "id" | "created_at">): Promise<AgentEventRecord>;
  listBySessionId(sessionId: string): Promise<AgentEventRecord[]>;
  listByAttemptId(attemptId: string): Promise<AgentEventRecord[]>;
  markSuperseded(attemptId: string): Promise<number>;
}

/**
 * ConversationLog is the canonical conversation state. It owns append-only
 * event storage, sequence numbers, supersession/rewind metadata, transcript
 * rendering, and Discord projection inputs. It does not start VMs or mutate
 * task state.
 */
export interface ConversationLog {
  /**
   * Append an event to the log. Returns the created row with its database id,
   * session-scoped `seq`, and attempt-scoped `attempt_seq`.
   */
  append(event: ConversationLogEventInput): Promise<AgentEventRecord>;

  /**
   * Mark every event belonging to an attempt as superseded. Used when a turn
   * is retried so stale partial output is excluded from the canonical
   * transcript and Discord projection.
   */
  markSuperseded(attemptId: string): Promise<number>;

  /**
   * Rebuild the canonical transcript for a session, ordered by `seq`.
   * Superseded events are excluded except for retained milestones such as
   * "attempt interrupted".
   */
  rebuildTranscript(sessionId: string): Promise<AgentEventRecord[]>;

  /**
   * Return the canonical events used to drive the Discord projection. This is
   * the same ordered set as the transcript, but may be consumed by the
   * progress bridge for rendering.
   */
  projectForDiscord(sessionId: string): Promise<AgentEventRecord[]>;
}

/**
 * Milestone event kinds that remain visible in Discord projections and
 * transcripts even when their owning attempt has been superseded. These are
 * operator-facing boundary events (interruptions, failures, environment
 * blockers) that explain why a retry occurred.
 */
const RETAINED_MILESTONE_KINDS: ReadonlySet<AgentEventKind> = new Set([
  "turn_failed",
  "turn_cancelled",
  "environment_issue",
]);

function isRetainedMilestone(record: AgentEventRecord): boolean {
  return record.superseded && RETAINED_MILESTONE_KINDS.has(record.event_kind);
}

export function isAgentEventKind(value: unknown): value is AgentEventKind {
  return typeof value === "string" && (AGENT_EVENT_KINDS as readonly string[]).includes(value);
}

const SECRET_KEY_PATTERN = /api[_-]?key|token|authorization|password|secret|credential|pat|private[_-]?key/i;

function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function looksLikeSecretValue(value: string): boolean {
  const redacted = redact(value);
  return redacted !== value;
}

/**
 * Recursively redact string values inside a JSON-serializable payload. Secrets
 * (tokens, URLs with credentials) are replaced with `[redacted]` before the
 * payload is persisted. Values under keys that look like secrets are redacted
 * regardless of whether the value itself matches a known secret pattern.
 */
export function redactPayload(payload: unknown, key?: string): unknown {
  if (typeof payload === "string") {
    if (key !== undefined && looksLikeSecretKey(key)) {
      return "[redacted]";
    }
    return redact(payload);
  }
  if (payload === null || payload === undefined) {
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => redactPayload(item, key));
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const itemKey of Object.keys(record)) {
      redacted[itemKey] = redactPayload(record[itemKey], itemKey);
    }
    return redacted;
  }
  return payload;
}

export class DurableConversationLog implements ConversationLog {
  constructor(private readonly store: ConversationLogStore) {}

  async append(event: ConversationLogEventInput): Promise<AgentEventRecord> {
    if (!isAgentEventKind(event.event_kind)) {
      throw new Error(`Unknown agent event kind: ${event.event_kind}`);
    }
    const existing = await this.store.listBySessionId(event.session_id);
    const seq = this.nextSequence(existing);
    const attemptEvents = existing.filter((e) => e.attempt_id === event.attempt_id);
    const attempt_seq = this.nextAttemptSequence(attemptEvents);

    return this.store.insert({
      session_id: event.session_id,
      turn_id: event.turn_id,
      attempt_id: event.attempt_id,
      seq,
      attempt_seq,
      event_kind: event.event_kind,
      payload: redactPayload(event.payload),
      superseded: false,
    });
  }

  async markSuperseded(attemptId: string): Promise<number> {
    return this.store.markSuperseded(attemptId);
  }

  async rebuildTranscript(sessionId: string): Promise<AgentEventRecord[]> {
    return this.canonicalEvents(sessionId);
  }

  async projectForDiscord(sessionId: string): Promise<AgentEventRecord[]> {
    return this.canonicalEvents(sessionId);
  }

  private async canonicalEvents(sessionId: string): Promise<AgentEventRecord[]> {
    const events = await this.store.listBySessionId(sessionId);
    return events
      .filter((event) => !event.superseded || isRetainedMilestone(event))
      .sort((a, b) => a.seq - b.seq);
  }

  private nextSequence(events: AgentEventRecord[]): number {
    if (events.length === 0) return 1;
    return Math.max(...events.map((event) => event.seq)) + 1;
  }

  private nextAttemptSequence(events: AgentEventRecord[]): number {
    if (events.length === 0) return 1;
    return Math.max(...events.map((event) => event.attempt_seq)) + 1;
  }
}
