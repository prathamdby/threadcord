import { TaskOrchestrator } from "../../src/task/orchestrator.js";
import type {
  FollowupResult,
  RestartReconciliation,
  TaskStorePort,
} from "../../src/task/store.js";
import type { AppConfig } from "../../src/config.js";
import {
  ACTIVE_STATUSES,
  type CancelOutcome,
  type ClaimedTurn,
  type NewTaskRecord,
  type TaskRecord,
  type TaskStatus,
} from "../../src/types.js";

export const CHANNEL_ID = "control-channel";

export const config: AppConfig = {
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
 * Faithful in-memory store. The capacity rule reuses ACTIVE_STATUSES and the
 * scheduler claims only `queued`, the same sources of truth the SQL store uses,
 * so the fake cannot drift from production on the admission and scheduling
 * invariants these tests guard. Drafts are created non-schedulable and only a
 * draft can be promoted, mirroring the SQL `attachAndPromote` guard.
 */
export class InMemoryStore implements TaskStorePort {
  private readonly tasks = new Map<string, TaskRecord>();
  private followups: StoredFollowup[] = [];
  private seq = 0;

  constructor(private readonly maxConcurrent: number) {}

  snapshot(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    return { ...task };
  }

  findByMessageId(messageId: string): TaskRecord | undefined {
    return clone(
      [...this.tasks.values()].find((t) => t.discordMessageId === messageId),
    );
  }

  taskCount(): number {
    return this.tasks.size;
  }

  followupCount(taskId: string): number {
    return this.followups.filter((f) => f.taskId === taskId).length;
  }

  async getByMessageId(messageId: string): Promise<TaskRecord | undefined> {
    return clone(
      [...this.tasks.values()].find((t) => t.discordMessageId === messageId),
    );
  }

  async getByThreadId(threadId: string): Promise<TaskRecord | undefined> {
    return clone(
      [...this.tasks.values()].find((t) => t.discordThreadId === threadId),
    );
  }

  async getByInstanceId(instanceId: string): Promise<TaskRecord | undefined> {
    return clone(
      [...this.tasks.values()].find((t) => t.flueInstanceId === instanceId),
    );
  }

  async createDraft(
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
      status: "draft",
      initialTurnStarted: false,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(record.id, record);
    return { task: clone(record), created: true };
  }

  async attachAndPromote(
    taskId: string,
    threadId: string,
    flueInstanceId: string,
    statusMessageId: string,
  ): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "draft") return undefined;
    task.discordThreadId = threadId;
    task.flueInstanceId = flueInstanceId;
    task.statusMessageId = statusMessageId;
    task.status = "queued";
    return clone(task);
  }

  async markDraftFailed(
    taskId: string,
    errorSummary: string,
  ): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "draft") return undefined;
    task.status = "failed";
    task.errorSummary = errorSummary;
    return clone(task);
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
    return clone(task);
  }

  async requestCancel(taskId: string): Promise<CancelOutcome> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    if (task.status === "queued" || task.status === "waiting") {
      task.status = "cancelled";
      this.dropFollowups(taskId);
      return { kind: "terminal", task: clone(task) };
    }
    if (task.status === "running") {
      task.status = "cancelling";
      this.dropFollowups(taskId);
      return { kind: "requested", task: clone(task) };
    }
    return { kind: "noop", task: clone(task) };
  }

  async reconcileAfterRestart(): Promise<RestartReconciliation> {
    const resumed: TaskRecord[] = [];
    const cancelled: TaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        task.status = "waiting";
        resumed.push(clone(task));
      } else if (task.status === "cancelling") {
        task.status = "cancelled";
        cancelled.push(clone(task));
      } else if (task.status === "draft") {
        task.status = "failed";
        task.errorSummary ??= "Draft abandoned before thread attachment";
      }
    }
    return { resumed, cancelled };
  }

  async enqueueFollowup(
    taskId: string,
    discordMessageId: string,
    instruction: string,
  ): Promise<FollowupResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    if (!["queued", "running", "waiting"].includes(task.status)) {
      return { ok: false, status: task.status };
    }
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
    const position = this.followups.filter(
      (f) => f.taskId === taskId && target && f.seq <= target.seq,
    ).length;
    return { ok: true, position, status: task.status };
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
      task: clone(candidate),
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
    return {
      task: clone(task),
      instruction: followup.instruction,
      source: "followup",
    };
  }

  private dropFollowups(taskId: string): void {
    this.followups = this.followups.filter((f) => f.taskId !== taskId);
  }
}

function clone<T extends TaskRecord | undefined>(task: T): T {
  return (task ? { ...task } : task) as T;
}

function byCreatedThenId(a: TaskRecord, b: TaskRecord): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

/** Lets a test make a Discord thread call fail at a chosen point. */
export interface ThreadFailure {
  createThread?: boolean;
  statusSend?: boolean;
}

/** What one channel-message submission did at the Discord boundary. */
export interface SubmitResult {
  task: TaskRecord | undefined;
  replies: string[];
  sends: string[];
  threadsCreated: number;
}

export class World {
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

  /** Submit a control-channel message and report what hit Discord. */
  async submitRaw(
    messageId: string,
    failure: ThreadFailure = {},
  ): Promise<SubmitResult> {
    const threadId = this.threadIdFor(messageId);
    const replies: string[] = [];
    const sends: string[] = [];
    let threadsCreated = 0;
    await this.orchestrator.handleChannelMessage({
      id: messageId,
      content: `Do the work\nrepo: acme/web\nbranch: main`,
      authorBot: false,
      channelId: CHANNEL_ID,
      reply: async (content) => void replies.push(content),
      createThread: async () => {
        if (failure.createThread) throw new Error("discord: thread create 500");
        threadsCreated += 1;
        return {
          id: threadId,
          send: async (content) => {
            if (failure.statusSend)
              throw new Error("discord: status send 500");
            sends.push(content);
            return { id: `status-${this.counter++}` };
          },
          editMessage: async () => {},
        };
      },
    });
    await flush();
    return {
      task: this.store.findByMessageId(messageId),
      replies,
      sends,
      threadsCreated,
    };
  }

  /** Submit and assert the happy path produced a task. */
  async submit(messageId: string): Promise<TaskRecord> {
    const result = await this.submitRaw(messageId);
    if (!result.task) throw new Error("Task not created");
    return result.task;
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
    await this.orchestrator.resumeAfterRestart();
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
