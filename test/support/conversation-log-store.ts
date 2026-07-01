import {
  type AgentEventRecord,
  type ConversationLogStore,
} from "../../src/agentturn/conversation-log.js";

export class InMemoryConversationLogStore implements ConversationLogStore {
  private records: AgentEventRecord[] = [];
  private nextId = 1;
  private readonly sessionSeq = new Map<string, number>();
  private readonly attemptSeq = new Map<string, number>();
  private readonly seqLocks = new Map<string, Promise<void>>();

  async insert(
    record: Omit<AgentEventRecord, "id" | "created_at">,
  ): Promise<AgentEventRecord> {
    const full: AgentEventRecord = {
      ...record,
      id: this.nextId++,
      created_at: new Date(),
    };
    this.records.push({ ...full });
    return { ...full };
  }

  async listBySessionId(sessionId: string): Promise<AgentEventRecord[]> {
    return this.records
      .filter((record) => record.session_id === sessionId)
      .map((record) => ({ ...record }));
  }

  async listByAttemptId(attemptId: string): Promise<AgentEventRecord[]> {
    return this.records
      .filter((record) => record.attempt_id === attemptId)
      .map((record) => ({ ...record }));
  }

  async markSuperseded(attemptId: string): Promise<number> {
    let count = 0;
    for (const record of this.records) {
      if (record.attempt_id === attemptId && !record.superseded) {
        record.superseded = true;
        count++;
      }
    }
    return count;
  }

  async nextSeq(sessionId: string): Promise<number> {
    return this.withSessionLock(sessionId, () => {
      const current = this.sessionSeq.get(sessionId) ?? 0;
      const next = current + 1;
      this.sessionSeq.set(sessionId, next);
      return next;
    });
  }

  async nextAttemptSeq(sessionId: string, attemptId: string): Promise<number> {
    const key = `${sessionId}:${attemptId}`;
    return this.withSessionLock(sessionId, () => {
      const current = this.attemptSeq.get(key) ?? 0;
      const next = current + 1;
      this.attemptSeq.set(key, next);
      return next;
    });
  }

  private async withSessionLock<T>(
    sessionId: string,
    fn: () => T,
  ): Promise<T> {
    const previous = this.seqLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.seqLocks.set(
      sessionId,
      previous.then(() => gate),
    );
    await previous;
    try {
      return fn();
    } finally {
      release();
    }
  }
}
