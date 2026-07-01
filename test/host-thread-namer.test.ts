import { describe, expect, it, vi } from "vitest";
import { HostThreadNamer } from "../src/agentturn/host-thread-namer.js";
import { flush } from "./support/orchestrator-harness.js";

describe("HostThreadNamer", () => {
  it("accepts a thread-namer role and emits turnStarted then terminal", async () => {
    const rename = vi.fn(async () => {});
    const namer = new HostThreadNamer({
      defaultModel: "anthropic/claude-sonnet-4-5",
      renameThread: rename,
    });
    const events: { type: string; outcome?: string | undefined }[] = [];
    namer.onEvent((event) => {
      events.push({ type: event.type, outcome: event.type === "terminal" ? event.outcome : undefined });
    });

    const result = await namer.prompt({
      instanceId: "discord:thread:thread-1",
      role: "thread-namer",
      instruction: "Fix the login bug",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: "",
      repo: "",
      baseBranch: "",
      setupProfileRevision: 0,
    });

    expect(result).toEqual({ accepted: true });
    await flush();
    expect(events).toEqual([
      { type: "turnStarted" },
      { type: "terminal", outcome: "completed" },
    ]);
  });

  it("rejects roles other than thread-namer", async () => {
    const namer = new HostThreadNamer({
      defaultModel: "anthropic/claude-sonnet-4-5",
      renameThread: vi.fn(async () => {}),
    });

    const result = await namer.prompt({
      instanceId: "discord:thread:thread-1",
      role: "coding",
      instruction: "Fix the login bug",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: "/workspaces/x",
      repo: "acme/web",
      baseBranch: "main",
      setupProfileRevision: 1,
    });

    expect(result).toEqual({
      accepted: false,
      reason: "HostThreadNamer only supports thread-namer role",
    });
  });

  it("derives a readable name from the instruction and calls renameThread", async () => {
    const rename = vi.fn(async () => {});
    const namer = new HostThreadNamer({
      defaultModel: "anthropic/claude-sonnet-4-5",
      renameThread: rename,
    });

    await namer.prompt({
      instanceId: "discord:thread:thread-1",
      role: "thread-namer",
      instruction: "Fix the login bug",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: "",
      repo: "",
      baseBranch: "",
      setupProfileRevision: 0,
    });
    await flush();

    expect(rename).toHaveBeenCalledWith("thread-1", "Fix the login bug");
  });

  it("does not call renameThread for empty or whitespace-only instructions", async () => {
    const rename = vi.fn(async () => {});
    const namer = new HostThreadNamer({
      defaultModel: "anthropic/claude-sonnet-4-5",
      renameThread: rename,
    });

    await namer.prompt({
      instanceId: "discord:thread:thread-1",
      role: "thread-namer",
      instruction: "   ",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: "",
      repo: "",
      baseBranch: "",
      setupProfileRevision: 0,
    });
    await flush();

    expect(rename).not.toHaveBeenCalled();
  });

  it("logs rename failures and emits a failed terminal without throwing", async () => {
    const logs: { level: string; message: string; meta?: Record<string, unknown> | undefined }[] = [];
    const logger = {
      log: (level: string, message: string, meta?: Record<string, unknown> | undefined) => {
        logs.push({ level, message, meta });
      },
    };
    const rename = vi.fn(async () => {
      throw new Error("discord: missing permissions");
    });
    const namer = new HostThreadNamer({
      defaultModel: "anthropic/claude-sonnet-4-5",
      renameThread: rename,
      logger,
      maxAttempts: 1,
    });
    const events: { type: string; outcome?: string | undefined }[] = [];
    namer.onEvent((event) => {
      events.push({ type: event.type, outcome: event.type === "terminal" ? event.outcome : undefined });
    });

    await namer.prompt({
      instanceId: "discord:thread:thread-1",
      role: "thread-namer",
      instruction: "Fix the login bug",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: "",
      repo: "",
      baseBranch: "",
      setupProfileRevision: 0,
    });
    await flush();

    expect(rename).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "terminal", outcome: "failed" });
    expect(
      logs.some(
        (log) =>
          log.message === "host-thread-namer-rename-failed" &&
          log.meta?.summary === "discord: missing permissions",
      ),
    ).toBe(true);
  });

  it("retries rename up to maxAttempts and times out each attempt", async () => {
    const rename = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error("discord: rate limited");
    });
    const namer = new HostThreadNamer({
      defaultModel: "anthropic/claude-sonnet-4-5",
      renameThread: rename,
      timeoutMs: 10,
      maxAttempts: 2,
    });
    const events: { type: string; outcome?: string | undefined }[] = [];
    namer.onEvent((event) => {
      events.push({ type: event.type, outcome: event.type === "terminal" ? event.outcome : undefined });
    });

    await namer.prompt({
      instanceId: "discord:thread:thread-1",
      role: "thread-namer",
      instruction: "Fix the login bug",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: "",
      repo: "",
      baseBranch: "",
      setupProfileRevision: 0,
    });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rename).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "terminal", outcome: "failed" });
  });

  it("unsubscribing onEvent stops future events", async () => {
    const rename = vi.fn(async () => {});
    const namer = new HostThreadNamer({
      defaultModel: "anthropic/claude-sonnet-4-5",
      renameThread: rename,
    });
    const events: string[] = [];
    const unsubscribe = namer.onEvent((event) => {
      events.push(event.type);
    });
    unsubscribe();

    await namer.prompt({
      instanceId: "discord:thread:thread-1",
      role: "thread-namer",
      instruction: "Fix the login bug",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: "",
      repo: "",
      baseBranch: "",
      setupProfileRevision: 0,
    });
    await flush();

    expect(events).toHaveLength(0);
  });

  it("cancel on a non-existent turn is a no-op", async () => {
    const namer = new HostThreadNamer({
      defaultModel: "anthropic/claude-sonnet-4-5",
      renameThread: vi.fn(async () => {}),
    });
    await expect(namer.cancel("discord:thread:unknown")).resolves.toBeUndefined();
  });
});
