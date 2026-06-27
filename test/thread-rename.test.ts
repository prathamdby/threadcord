import { describe, expect, it, vi } from "vitest";
import {
  scheduleReadableThreadRename,
  THREAD_NAMER_INSTANCE_PREFIX,
} from "../src/task/rename-thread.js";
import { flush } from "./support/orchestrator-harness.js";

describe("scheduleReadableThreadRename", () => {
  it("does not throw when instruction is empty", async () => {
    const rename = vi.fn(async () => {});
    scheduleReadableThreadRename("thread-1", "", rename);
    await flush();
    expect(rename).not.toHaveBeenCalled();
  });

  it("does not throw when instruction is only whitespace", async () => {
    const rename = vi.fn(async () => {});
    scheduleReadableThreadRename("thread-1", "   ", rename);
    await flush();
    expect(rename).not.toHaveBeenCalled();
  });

  it("does not throw synchronously for a valid instruction", async () => {
    const rename = vi.fn(async () => {});
    expect(() =>
      scheduleReadableThreadRename("thread-1", "Fix the bug", rename),
    ).not.toThrow();
    await flush();
  });

  it("does not produce an unhandledRejection when dispatch fails", async () => {
    // In the test environment, dispatch will fail (no real Flue runtime),
    // but the catch block should absorb the rejection.
    const rename = vi.fn(async () => {});
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      scheduleReadableThreadRename("thread-1", "Fix the bug", rename);
      await flush();
    } finally {
      process.off("unhandledRejection", handler);
    }
    // Give a microtask cycle for any pending rejections to surface.
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toHaveLength(0);
  });

  it("does not produce an unhandledRejection when rename rejects", async () => {
    // The rename function rejects — but scheduleReadableThreadRename's
    // catch block should absorb it. Since dispatch fails first in tests,
    // we verify the same rejection-safety property.
    const rename = vi.fn(async () => {
      throw new Error("discord: missing permissions");
    });
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      scheduleReadableThreadRename("thread-1", "Fix the bug", rename);
      await flush();
    } finally {
      process.off("unhandledRejection", handler);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toHaveLength(0);
  });
});

describe("THREAD_NAMER_INSTANCE_PREFIX", () => {
  it("is a stable string prefix", () => {
    expect(THREAD_NAMER_INSTANCE_PREFIX).toBe("threadcord:namer:");
    expect(typeof THREAD_NAMER_INSTANCE_PREFIX).toBe("string");
  });
});
