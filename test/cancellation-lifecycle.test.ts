import { beforeEach, describe, expect, it } from "vitest";
import { TaskOrchestrator } from "../src/task/orchestrator.js";
import type {
  RestartReconciliation,
  TaskStorePort,
} from "../src/task/store.js";
import { toFlueInstanceId } from "../src/ids.js";
import type { AppConfig } from "../src/config.js";
import {
  ACTIVE_STATUSES,
  type CancelOutcome,
  type ClaimedTurn,
  type NewTaskRecord,
  type TaskRecord,
  type TaskStatus,
} from "../src/types.js";

const CHANNEL_ID = "control-channel";

const config: AppConfig = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "token",
  DISCORD_CHANNEL_ID: CHANNEL_ID,
  GITHUB_TOKEN: "github",
  WORKSPACE_ROOT: "/workspaces",
  MAX_CONCURRENT_TASKS: 1,
  PORT: 3583,
  WORKSPACE_TTL_DAYS: 14,
  ANTHROPIC_API_KEY: "anthropic-key",
  anthropicModels: ["claude-sonnet-4-5"],
  openaiModels: [],
  customProviders: [],
  allowedModels: ["anthropic/claude-sonnet-4-5"],
  defaultModel: "anthropic/claude-sonnet-4-5",
};

interface StoredFollowup {
  seq: number;
  taskId: string;
  discordMessageId: string;
  instruction: string;
}

/**
 * Faithful in-memory store. The capacity rule reuses ACTIVE_STATUSES, the same
 * source of truth the SQL store counts against, so the fake cannot drift from
 * production on the one invariant these tests guard.
 */
class InMemoryStore implements TaskStorePort {
  private readonly tasks = new Map<string, TaskRecord>();
  private followups: StoredFollowup[] = [];
  private seq = 0;

  constructor(private readonly maxConcurrent: number) {}

  snapshot(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    return { ...task };
  }

  followupCount(taskId: string): number {
    return this.followups.filter((f) => f.taskId === taskId).length;
  }

  async getByMessageId(messageId: string): Promise<TaskRecord | undefined> {
    return [...this.tasks.values()].find(
      (t) => t.discordMessageId === messageId,
    );
  }

  async getByThreadId(threadId: string): Promise<TaskRecord | undefined> {
    return [...this.tasks.values()].find(
      (t) => t.discordThreadId === threadId,
    );
  }

  async getByInstanceId(instanceId: string): Promise<TaskRecord | undefined> {
    return [...this.tasks.values()].find(
      (t) => t.flueInstanceId === instanceId,
    );
  }

  async createTask(
    task: NewTaskRecord,
  ): Promise<{ task: TaskRecord; created: boolean }> {
    const existing = await this.getByMessageId(task.discordMessageId);
    if (existing) return { task: existing, created: false };
    const now = new Date(this.seq++);
    const record: TaskRecord = {
      id: task.id,
      discordMessageId: task.discordMessageId,
      discordThreadId: task.discordThreadId,
      flueInstanceId: task.flueInstanceId,
      workspacePath: task.workspacePath,
      repo: task.repo,
      branch: task.branch,
      model: task.model,
      instruction: task.instruction,
      ...(task.pushOverride ? { pushOverride: task.pushOverride } : {}),
      status: "queued",
      initialTurnStarted: false,
      ...(task.statusMessageId ? { statusMessageId: task.statusMessageId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(record.id, record);
    return { task: record, created: true };
  }

  async attachDiscordThread(
    taskId: string,
    threadId: string,
    flueInstanceId: string,
    statusMessageId: string,
  ): Promise<TaskRecord> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    task.discordThreadId = threadId;
    task.flueInstanceId = flueInstanceId;
    task.statusMessageId = statusMessageId;
    return task;
  }

  async claimNextTurn(preferTaskId?: string): Promise<ClaimedTurn | undefined> {
    const active = [...this.tasks.values()].filter((t) =>
      (ACTIVE_STATUSES as readonly TaskStatus[]).includes(t.status),
    ).length;
    if (active >= this.maxConcurrent) return undefined;

    return (
      this.claimFollowup(preferTaskId) ??
      this.claimInitial(preferTaskId) ??
      this.claimFollowup(undefined)
    );
  }

  async queuePosition(taskId: string): Promise<number> {
    const target = this.tasks.get(taskId);
    if (!target) return 0;
    return [...this.tasks.values()].filter(
      (t) => t.status === "queued" && t.createdAt <= target.createdAt,
    ).length;
  }

  async transition(
    taskId: string,
    from: TaskStatus | TaskStatus[],
    to: TaskStatus,
    errorSummary?: string,
  ): Promise<TaskRecord | undefined> {
    const fromList = Array.isArray(from) ? from : [from];
    const task = this.tasks.get(taskId);
    if (!task || !fromList.includes(task.status)) return undefined;
    task.status = to;
    if (errorSummary !== undefined) task.errorSummary = errorSummary;
    return task;
  }

  async requestCancel(taskId: string): Promise<CancelOutcome> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    if (task.status === "queued" || task.status === "waiting") {
      task.status = "cancelled";
      this.dropFollowups(taskId);
      return { kind: "terminal", task };
    }
    if (task.status === "running") {
      task.status = "cancelling";
      this.dropFollowups(taskId);
      return { kind: "requested", task };
    }
    return { kind: "noop", task };
  }

  async reconcileAfterRestart(): Promise<RestartReconciliation> {
    const resumed: TaskRecord[] = [];
    const cancelled: TaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        task.status = "waiting";
        resumed.push(task);
      } else if (task.status === "cancelling") {
        task.status = "cancelled";
        cancelled.push(task);
      }
    }
    return { resumed, cancelled };
  }

  async enqueueFollowup(
    taskId: string,
    discordMessageId: string,
    instruction: string,
  ): Promise<number> {
    if (!this.followups.some((f) => f.discordMessageId === discordMessageId)) {
      this.followups.push({
        seq: this.seq++,
        taskId,
        discordMessageId,
        instruction,
      });
    }
    const target = this.followups.find(
      (f) => f.discordMessageId === discordMessageId,
    );
    return this.followups.filter(
      (f) => f.taskId === taskId && target && f.seq <= target.seq,
    ).length;
  }

  private claimInitial(preferTaskId?: string): ClaimedTurn | undefined {
    const candidate = [...this.tasks.values()]
      .filter(
        (t) =>
          t.status === "queued" &&
          (preferTaskId === undefined || t.id === preferTaskId),
      )
      .sort(byCreatedThenId)[0];
    if (!candidate) return undefined;
    candidate.status = "running";
    candidate.initialTurnStarted = true;
    return {
      task: candidate,
      instruction: candidate.instruction,
      source: "initial",
    };
  }

  private claimFollowup(preferTaskId?: string): ClaimedTurn | undefined {
    const followup = this.followups
      .filter((f) => {
        const task = this.tasks.get(f.taskId);
        return (
          task?.status === "waiting" &&
          task.initialTurnStarted &&
          (preferTaskId === undefined || task.id === preferTaskId)
        );
      })
      .sort((a, b) => a.seq - b.seq)[0];
    if (!followup) return undefined;
    this.followups = this.followups.filter((f) => f.seq !== followup.seq);
    const task = this.tasks.get(followup.taskId)!;
    task.status = "running";
    return { task, instruction: followup.instruction, source: "followup" };
  }

  private dropFollowups(taskId: string): void {
    this.followups = this.followups.filter((f) => f.taskId !== taskId);
  }
}

function byCreatedThenId(a: TaskRecord, b: TaskRecord): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

class World {
  readonly store: InMemoryStore;
  readonly orchestrator: TaskOrchestrator;
  readonly dispatched: string[] = [];
  readonly posts: Array<{ threadId: string; content: string }> = [];
  private counter = 0;

  constructor(maxConcurrent = config.MAX_CONCURRENT_TASKS) {
    this.store = new InMemoryStore(maxConcurrent);
    this.orchestrator = new TaskOrchestrator(
      { ...config, MAX_CONCURRENT_TASKS: maxConcurrent },
      this.store,
      async (instanceId) => {
        this.dispatched.push(instanceId);
      },
      async (task) => `/workspaces/${task.id}`,
    );
    this.orchestrator.setMilestonePublisher(async (threadId, content) => {
      this.posts.push({ threadId, content });
    });
  }

  threadIdFor(messageId: string): string {
    return `thread-${messageId}`;
  }

  async submit(messageId: string): Promise<TaskRecord> {
    const threadId = this.threadIdFor(messageId);
    const replies: string[] = [];
    const sends: string[] = [];
    await this.orchestrator.handleChannelMessage({
      id: messageId,
      content: `Do the work\nrepo: acme/web\nbranch: main`,
      authorBot: false,
      channelId: CHANNEL_ID,
      reply: async (content) => void replies.push(content),
      createThread: async () => ({
        id: threadId,
        send: async (content) => {
          sends.push(content);
          return { id: `status-${this.counter++}` };
        },
        editMessage: async () => {},
      }),
    });
    await flush();
    const task = await this.store.getByMessageId(messageId);
    if (!task) throw new Error("Task not created");
    return task;
  }

  async command(threadId: string, content: string): Promise<string[]> {
    const replies: string[] = [];
    await this.orchestrator.handleThreadMessage({
      id: `msg-${this.counter++}`,
      content,
      authorBot: false,
      channelId: threadId,
      reply: async (reply) => void replies.push(reply),
    });
    await flush();
    return replies;
  }

  async endTurn(instanceId: string): Promise<void> {
    await this.orchestrator.handleAgentEnd(instanceId);
    await flush();
  }

  async restart(): Promise<void> {
    await this.orchestrator.resumeAfterRestart(async (threadId, content) => {
      this.posts.push({ threadId, content });
    });
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let world: World;

beforeEach(() => {
  world = new World();
});

describe("cancelling a queued task", () => {
  it("ends it immediately, drops follow-ups, and lets another queued task run", async () => {
    const running = await world.submit("m-running");
    const queued = await world.submit("m-queued");
    const other = await world.submit("m-other");

    expect(world.store.snapshot(running.id).status).toBe("running");
    expect(world.store.snapshot(queued.id).status).toBe("queued");

    await world.command(queued.discordThreadId, "follow up please");
    expect(world.store.followupCount(queued.id)).toBe(1);

    const replies = await world.command(queued.discordThreadId, "cancel");
    expect(replies[0]).toContain("Cancelled");
    expect(world.store.snapshot(queued.id).status).toBe("cancelled");
    expect(world.store.followupCount(queued.id)).toBe(0);

    await world.endTurn(running.flueInstanceId);

    expect(world.store.snapshot(other.id).status).toBe("running");
    expect(world.store.snapshot(queued.id).status).toBe("cancelled");
  });
});

describe("cancelling a waiting task", () => {
  it("ends it immediately, drops follow-ups, and claims no new turn", async () => {
    const first = await world.submit("m-first");
    const second = await world.submit("m-second");

    await world.endTurn(first.flueInstanceId);
    expect(world.store.snapshot(first.id).status).toBe("waiting");
    expect(world.store.snapshot(second.id).status).toBe("running");

    await world.command(first.discordThreadId, "another change");
    expect(world.store.followupCount(first.id)).toBe(1);
    expect(world.store.snapshot(first.id).status).toBe("waiting");

    const replies = await world.command(first.discordThreadId, "cancel");
    expect(replies[0]).toContain("Cancelled");
    expect(world.store.snapshot(first.id).status).toBe("cancelled");
    expect(world.store.followupCount(first.id)).toBe(0);
    expect(world.store.snapshot(second.id).status).toBe("running");
  });
});

describe("cancelling a running task", () => {
  it("holds the slot, rejects follow-ups, and frees capacity only after agent end", async () => {
    const running = await world.submit("m-run");
    const queued = await world.submit("m-wait");
    expect(world.store.snapshot(running.id).status).toBe("running");
    expect(world.store.snapshot(queued.id).status).toBe("queued");

    const cancelReplies = await world.command(
      running.discordThreadId,
      "cancel",
    );
    expect(cancelReplies[0]).toContain("Cancellation requested");
    expect(world.store.snapshot(running.id).status).toBe("cancelling");

    // The queued task must not start while the cancelling turn holds the slot.
    expect(world.store.snapshot(queued.id).status).toBe("queued");
    expect(world.dispatched).not.toContain(queued.flueInstanceId);

    const followReplies = await world.command(
      running.discordThreadId,
      "keep going",
    );
    expect(followReplies[0]).toContain("Cancellation is in progress");
    expect(world.store.followupCount(running.id)).toBe(0);

    await world.endTurn(running.flueInstanceId);
    expect(world.store.snapshot(running.id).status).toBe("cancelled");
    expect(world.store.snapshot(queued.id).status).toBe("running");
    expect(world.posts.some((p) => p.content.includes("Cancellation complete"))).toBe(
      true,
    );
  });
});

describe("restart reconciliation", () => {
  it("finalizes cancelling work instead of resurrecting it", async () => {
    const world2 = new World(2);
    const a = await world2.submit("m-a");
    const b = await world2.submit("m-b");
    expect(world2.store.snapshot(a.id).status).toBe("running");
    expect(world2.store.snapshot(b.id).status).toBe("running");

    await world2.command(a.discordThreadId, "cancel");
    expect(world2.store.snapshot(a.id).status).toBe("cancelling");

    await world2.restart();

    expect(world2.store.snapshot(a.id).status).toBe("cancelled");
    expect(world2.store.snapshot(b.id).status).toBe("waiting");
    expect(
      world2.posts.some(
        (p) =>
          p.threadId === a.discordThreadId &&
          p.content.includes("Cancellation complete after restart"),
      ),
    ).toBe(true);
  });
});

describe("cancellation replies at the command boundary", () => {
  it("distinguishes immediate cancellation from requested cancellation", async () => {
    const running = await world.submit("m-running");
    const queued = await world.submit("m-queued");

    const queuedReply = (await world.command(queued.discordThreadId, "cancel"))[0];
    const runningReply = (
      await world.command(running.discordThreadId, "cancel")
    )[0];

    expect(queuedReply).toContain("No further turns will be dispatched");
    expect(runningReply).toContain("still winding down");
    expect(queuedReply).not.toEqual(runningReply);

    const repeat = (await world.command(running.discordThreadId, "cancel"))[0];
    expect(repeat).toContain("already cancelling");
  });
});
