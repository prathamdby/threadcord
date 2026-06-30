import {
  type TurnAttemptRecord,
  type TurnAttemptStore,
} from "../../src/agentturn/turnrunner.js";

export class InMemoryTurnAttemptStore implements TurnAttemptStore {
  private readonly records = new Map<string, TurnAttemptRecord>();

  async insert(record: TurnAttemptRecord): Promise<void> {
    this.records.set(record.attempt_id, { ...record });
  }

  async get(attemptId: string): Promise<TurnAttemptRecord | undefined> {
    const record = this.records.get(attemptId);
    return record ? { ...record } : undefined;
  }

  async listByTurnId(turnId: string): Promise<TurnAttemptRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.turn_id === turnId)
      .sort((a, b) => a.attempt_number - b.attempt_number)
      .map((record) => ({ ...record }));
  }

  async listActive(): Promise<TurnAttemptRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === "active")
      .map((record) => ({ ...record }));
  }

  async update(
    attemptId: string,
    patch: Partial<TurnAttemptRecord>,
  ): Promise<TurnAttemptRecord | undefined> {
    const existing = this.records.get(attemptId);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.records.set(attemptId, updated);
    return { ...updated };
  }
}
