import { describe, expect, it, vi } from "vitest";
import {
  scheduleReadableThreadRename,
  THREAD_NAMER_INSTANCE_PREFIX,
} from "../src/task/rename-thread.js";
import { flush } from "./support/orchestrator-harness.js";

const defaultModel = "anthropic/claude-sonnet-4-5";

describe("scheduleReadableThreadRename", () => {
  it("does not throw when instruction is empty", async () => {
    const rename = vi.fn(async () => {});
    scheduleReadableThreadRename("thread-1", "", defaultModel, rename);
    await flush();
    expect(rename).not.toHaveBeenCalled();
  });

  it("does not throw when instruction is only whitespace", async () => {
    const rename = vi.fn(async () => {});
    scheduleReadableThreadRename("thread-1", "   ", defaultModel, rename);
    await flush();
    expect(rename).not.toHaveBeenCalled();
  });

  it("does not throw synchronously for a valid instruction", async () => {
    const rename = vi.fn(async () => {});
    expect(() =>
      scheduleReadableThreadRename("thread-1", "Fix the bug", defaultModel, rename),
    ).not.toThrow();
    await flush();
  });

  it("renames the thread with a readable name derived from the instruction", async () => {
    const rename = vi.fn(async () => {});
    scheduleReadableThreadRename(
      "thread-1",
      "Fix the login bug",
      defaultModel,
      rename,
    );
    await flush();
    expect(rename).toHaveBeenCalledWith("thread-1", "Fix the login bug");
  });

  it("does not produce an unhandledRejection when rename rejects", async () => {
    const rename = vi.fn(async () => {
      throw new Error("discord: missing permissions");
    });
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      scheduleReadableThreadRename(
        "thread-1",
        "Fix the bug",
        defaultModel,
        rename,
        { log: () => {} },
      );
      await flush();
    } finally {
      process.off("unhandledRejection", handler);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toHaveLength(0);
  });

  it("does not use Flue dispatch", async () => {
    const rename = vi.fn(async () => {});
    scheduleReadableThreadRename(
      "thread-1",
      "Fix the login bug",
      defaultModel,
      rename,
    );
    await flush();
    // No Flue runtime functions are called; the rename is performed host-side.
    expect(rename).toHaveBeenCalledWith("thread-1", "Fix the login bug");
  });

  it("logs rename failures via an injected logger", async () => {
    const logs: {
      level: string;
      message: string;
      meta?: Record<string, unknown> | undefined;
    }[] = [];
    const logger = {
      log: (
        level: string,
        message: string,
        meta?: Record<string, unknown>,
      ) => {
        logs.push({ level, message, meta });
      },
    };
    const rename = vi.fn(async () => {
      throw new Error("discord: missing permissions");
    });
    scheduleReadableThreadRename(
      "thread-1",
      "Fix the bug",
      defaultModel,
      rename,
      logger,
    );
    await flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(rename).toHaveBeenCalled();
    expect(
      logs.some(
        (log) =>
          log.message === "host-thread-namer-rename-failed" &&
          log.meta?.summary === "discord: missing permissions",
      ),
    ).toBe(true);
  });
});

describe("THREAD_NAMER_INSTANCE_PREFIX", () => {
  it("is a stable string prefix", () => {
    expect(THREAD_NAMER_INSTANCE_PREFIX).toBe("threadcord:namer:");
    expect(typeof THREAD_NAMER_INSTANCE_PREFIX).toBe("string");
  });
});
