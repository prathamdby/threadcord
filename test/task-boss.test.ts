import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const mockState = vi.hoisted(() => ({
  ctorOptions: [] as unknown[],
  started: [] as boolean[],
  createQueueCalls: [] as { name: string; options: unknown }[],
  stopOptions: [] as unknown[],
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    constructor(options: unknown) {
      mockState.ctorOptions.push(options);
    }
    on() {}
    async start() {
      mockState.started.push(true);
      return this;
    }
    async createQueue(name: string, options?: unknown) {
      mockState.createQueueCalls.push({ name, options });
    }
    async stop(options?: unknown) {
      mockState.stopOptions.push(options);
    }
  },
}));

import {
  TASK_TURN_DEAD_LETTER_QUEUE,
  TASK_TURN_QUEUE,
  createStartedBoss,
  ensureTaskQueues,
  stopBoss,
} from "../src/task/boss.js";

const config = loadConfig({
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "token",
  GITHUB_TOKEN: "github",
  ANTHROPIC_API_KEY: "anthropic-key",
  ANTHROPIC_MODELS: "claude-sonnet-4-5",
});

describe("task boss", () => {
  beforeEach(() => {
    mockState.ctorOptions.length = 0;
    mockState.started.length = 0;
    mockState.createQueueCalls.length = 0;
    mockState.stopOptions.length = 0;
  });

  it("createStartedBoss constructs PgBoss with threadcord options and starts it", async () => {
    await createStartedBoss(config);

    expect(mockState.ctorOptions).toHaveLength(1);
    expect(mockState.ctorOptions[0]).toMatchObject({
      connectionString: "postgres://example",
      application_name: "threadcord",
      schedule: true,
      supervise: true,
    });
    expect(mockState.started).toEqual([true]);
  });

  it("ensureTaskQueues creates the dead-letter queue before the main task queue", async () => {
    const boss = await createStartedBoss(config);
    await ensureTaskQueues(boss, config);

    const deadIdx = mockState.createQueueCalls.findIndex(
      (call) => call.name === TASK_TURN_DEAD_LETTER_QUEUE,
    );
    const mainIdx = mockState.createQueueCalls.findIndex(
      (call) => call.name === TASK_TURN_QUEUE,
    );

    expect(deadIdx).toBeGreaterThanOrEqual(0);
    expect(mainIdx).toBeGreaterThanOrEqual(0);
    expect(deadIdx).toBeLessThan(mainIdx);

    const deadOptions = mockState.createQueueCalls[deadIdx]!.options as Record<
      string,
      unknown
    >;
    expect(deadOptions).toMatchObject({
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
    });

    const mainOptions = mockState.createQueueCalls[mainIdx]!.options as Record<
      string,
      unknown
    >;
    expect(mainOptions).toMatchObject({
      policy: "key_strict_fifo",
      deadLetter: TASK_TURN_DEAD_LETTER_QUEUE,
      retryLimit: 3,
      retryBackoff: true,
      heartbeatSeconds: 60,
      expireInSeconds: 7200,
      // TURN_RETENTION_DAYS (14) * 86400
      retentionSeconds: 14 * 86_400,
      deleteAfterSeconds: 14 * 86_400,
    });
  });

  it("stopBoss drains pg-boss gracefully with the default timeout", async () => {
    const boss = await createStartedBoss(config);
    await stopBoss(boss);

    expect(mockState.stopOptions).toEqual([
      { close: true, graceful: true, timeout: 25_000 },
    ]);
  });
});
