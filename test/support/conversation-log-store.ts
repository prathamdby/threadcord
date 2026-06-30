import {
  type AgentEventRecord,
  type ConversationLogStore,
} from "../../src/agentturn/conversation-log.js";

export class InMemoryConversationLogStore implements ConversationLogStore {
  private records: AgentEventRecord[] = [];
  private nextId = 1;

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
}
