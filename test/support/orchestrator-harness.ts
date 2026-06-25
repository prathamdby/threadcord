import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TaskOrchestrator } from "../../src/task/orchestrator.js";
import type { AppConfig } from "../../src/config.js";
import type { SetupEnvironment, SetupProfile } from "../../src/setup/profile.js";
import type { SetupStore } from "../../src/setup/store.js";
import type {
  ClaimedTurn,
  NewTaskRecord,
  TaskRecord,
  TaskStatus,
} from "../../src/types.js";

export const CHANNEL_ID = "control-channel";
const TEST_WORKSPACE_ROOT = join(process.cwd(), "test", "tmp", "workspaces");

export const config: AppConfig = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "token",
  DISCORD_CHANNEL_ID: CHANNEL_ID,
  GITHUB_TOKEN: "github",
  WORKSPACE_ROOT: TEST_WORKSPACE_ROOT,
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

const setupEnvironment: SetupEnvironment = {
  install: "true",
  start: "",
  checks: {},
  requiredEnv: [],
  requiredServices: [],
};

const readyProfile: SetupProfile = {
  id: "profile-1",
  repo: "acme/web",
  branch: "main",
  status: "ready",
  revision: 2,
  environment: setupEnvironment,
  memoryMarkdown: "setup memory",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

export const fakeSetupStore = {
  getReadyProfile: async () => readyProfile,
} as unknown as SetupStore;

interface StoredFollowup {
  seq: number;
  taskId: string;
  discordMessageId: string;
  instruction: string;
}

export class InMemoryStore {
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

  async getByMessageId(messageId: string): Promise<TaskRecord | undefined> {
    return this.findByMessageId(messageId);
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
      setupProfileRevision: task.setupProfileRevision,
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
    task.progressMessageIds = [statusMessageId];
    task.status = "queued";
    return clone(task);
  }

  async appendProgressMessageId(
    taskId: string,
    messageId: string,
  ): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const base =
      task.progressMessageIds ??
      (task.statusMessageId ? [task.statusMessageId] : []);
    task.progressMessageIds = [...base, messageId];
    return clone(task);
  }

  seedTask(task: TaskRecord): void {
    this.tasks.set(task.id, { ...task });
  }

  async markDraftFailed(
    taskId: string,
    errorSummary: string,
  ): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "draft") return undefined;
    task.status = "failed";
    task.errorSummary = errorSummary;
    task.progressMessageIds ??= [`unattached:${task.id}`];
    return clone(task);
  }

  async failAbandonedDrafts(): Promise<TaskRecord[]> {
    const failed: TaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "draft") continue;
      task.status = "failed";
      task.errorSummary ??= "Draft abandoned before thread attachment";
      task.progressMessageIds ??= [`unattached:${task.id}`];
      failed.push(clone(task));
    }
    return failed;
  }

  async claimNextTurn(preferTaskId?: string): Promise<ClaimedTurn | undefined> {
    const active = [...this.tasks.values()].filter(
      (t) => t.status === "running",
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

  async cancelTask(taskId: string): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || !["queued", "waiting", "running"].includes(task.status)) {
      return undefined;
    }
    task.status = "cancelled";
    this.followups = this.followups.filter((f) => f.taskId !== taskId);
    return clone(task);
  }

  async releaseRunningAfterRestart(): Promise<TaskRecord[]> {
    const resumed: TaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.status = "waiting";
      resumed.push(clone(task));
    }
    return resumed;
  }

  async enqueueFollowup(
    taskId: string,
    discordMessageId: string,
    instruction: string,
  ): Promise<number> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
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
}

function clone<T extends TaskRecord | undefined>(task: T): T {
  if (!task) return task as T;
  const normalized: TaskRecord =
    task.progressMessageIds === undefined && task.statusMessageId !== undefined
      ? { ...task, progressMessageIds: [task.statusMessageId] }
      : { ...task };
  return normalized as T;
}

function byCreatedThenId(a: TaskRecord, b: TaskRecord): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

export interface ThreadFailure {
  createThread?: boolean;
  statusSend?: boolean;
}

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
  private counter = 0;

  constructor(maxConcurrent = config.MAX_CONCURRENT_TASKS) {
    this.store = new InMemoryStore(maxConcurrent);
    this.orchestrator = new TaskOrchestrator(
      { ...config, MAX_CONCURRENT_TASKS: maxConcurrent },
      this.store as unknown as import("../../src/task/store.js").TaskStore,
      fakeSetupStore,
      async (instanceId) => {
        this.dispatched.push(instanceId);
      },
      async (task) => {
        const path = join(TEST_WORKSPACE_ROOT, task.id);
        await mkdir(path, { recursive: true });
        return path;
      },
      async () => {},
    );
  }

  threadIdFor(messageId: string): string {
    return `thread-${messageId}`;
  }

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
            if (failure.statusSend) throw new Error("discord: status send 500");
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

  async restart(): Promise<void> {
    await this.orchestrator.resumeAfterRestart(async () => {});
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
