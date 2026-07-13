import { describe, expect, it, vi } from "vitest";
import { cleanup, startWorkspaceJanitor } from "../src/task/janitor.js";
import { InMemoryTurnStore } from "./support/orchestrator-harness.js";
import type { TaskStore } from "../src/task/store.js";

const noWorkspaceStore = {
  listExpiredWorkspacePaths: async () => [],
} as unknown as TaskStore;

describe("turn retention", () => {
  it("loops deleteAgedTerminalTurns until a short batch", async () => {
    const callLog: { retentionDays: number; batchSize: number }[] = [];
    let callCount = 0;
    const mockTurnStore = {
      deleteAgedTerminalTurns: vi.fn(
        async (retentionDays: number, batchSize: number) => {
          callLog.push({ retentionDays, batchSize });
          callCount += 1;
          // First batch is full (5000), second is short (3000).
          return callCount === 1 ? 5000 : 3000;
        },
      ),
    } as unknown as import("../src/task/turn-store.js").TurnStore;

    await cleanup({
      store: noWorkspaceStore,
      workspaceTtlDays: 14,
      turnStore: mockTurnStore,
      turnRetentionDays: 14,
    });

    // Exactly 2 calls: the first returned a full batch, the second a short one.
    expect(callLog).toHaveLength(2);
    expect(callLog[0]).toEqual({ retentionDays: 14, batchSize: 5000 });
    expect(callLog[1]).toEqual({ retentionDays: 14, batchSize: 5000 });
  });

  it("does not call deleteAgedTerminalTurns when turnStore is not provided", async () => {
    const mockTurnStore = {
      deleteAgedTerminalTurns: vi.fn(async () => 0),
    } as unknown as import("../src/task/turn-store.js").TurnStore;

    await cleanup({
      store: noWorkspaceStore,
      workspaceTtlDays: 14,
      // turnStore and turnRetentionDays omitted
    });

    expect(mockTurnStore.deleteAgedTerminalTurns).not.toHaveBeenCalled();
  });

  it("only deletes terminal turns aged past the TTL", async () => {
    const turnStore = new InMemoryTurnStore();
    const now = new Date();
    const oldDate = new Date(now.getTime() - 30 * 86_400_000); // 30 days ago
    const recentDate = new Date(now.getTime() - 1 * 86_400_000); // 1 day ago

    // Aged terminal turns (should be deleted).
    turnStore.seedTurn({
      id: "turn-old-completed",
      taskId: "task-1",
      source: "initial",
      instruction: "done",
      status: "completed",
      attemptCount: 1,
      createdAt: oldDate,
      updatedAt: oldDate,
    });
    turnStore.seedTurn({
      id: "turn-old-failed",
      taskId: "task-2",
      source: "initial",
      instruction: "failed",
      status: "failed",
      attemptCount: 3,
      createdAt: oldDate,
      updatedAt: oldDate,
    });
    turnStore.seedTurn({
      id: "turn-old-cancelled",
      taskId: "task-3",
      source: "followup",
      instruction: "cancelled",
      status: "cancelled",
      attemptCount: 1,
      createdAt: oldDate,
      updatedAt: oldDate,
    });

    // Recent terminal turn (should NOT be deleted — within retention).
    turnStore.seedTurn({
      id: "turn-recent-completed",
      taskId: "task-4",
      source: "initial",
      instruction: "done recently",
      status: "completed",
      attemptCount: 1,
      createdAt: recentDate,
      updatedAt: recentDate,
    });

    // Aged non-terminal turns (should NOT be deleted — not terminal).
    turnStore.seedTurn({
      id: "turn-old-queued",
      taskId: "task-5",
      source: "initial",
      instruction: "still queued",
      status: "queued",
      attemptCount: 0,
      createdAt: oldDate,
      updatedAt: oldDate,
    });
    turnStore.seedTurn({
      id: "turn-old-running",
      taskId: "task-6",
      source: "initial",
      instruction: "still running",
      status: "running",
      attemptCount: 1,
      createdAt: oldDate,
      updatedAt: oldDate,
    });

    await cleanup({
      store: noWorkspaceStore,
      workspaceTtlDays: 14,
      turnStore: turnStore as unknown as import("../src/task/turn-store.js").TurnStore,
      turnRetentionDays: 14,
    });

    // Aged terminal turns were deleted.
    expect(turnStore.snapshotTurn("turn-old-completed")).toBeUndefined();
    expect(turnStore.snapshotTurn("turn-old-failed")).toBeUndefined();
    expect(turnStore.snapshotTurn("turn-old-cancelled")).toBeUndefined();

    // Recent terminal turn was retained.
    expect(turnStore.snapshotTurn("turn-recent-completed")).toBeDefined();

    // Non-terminal turns were retained regardless of age.
    expect(turnStore.snapshotTurn("turn-old-queued")).toBeDefined();
    expect(turnStore.snapshotTurn("turn-old-running")).toBeDefined();
  });

  it("does not produce an unhandledRejection when janitor cleanup rejects", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", handler);
    let interval: NodeJS.Timeout | undefined;
    try {
      const store = {
        listExpiredWorkspacePaths: vi
          .fn()
          .mockRejectedValue(new Error("pg down")),
      } as unknown as TaskStore;

      interval = startWorkspaceJanitor({
        store,
        workspaceTtlDays: 14,
        intervalMs: 1_000,
      });

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(rejections).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(
        "[threadcord] workspace janitor failed:",
        "pg down",
      );
    } finally {
      if (interval) clearInterval(interval);
      process.off("unhandledRejection", handler);
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
