import { join } from "node:path";
import { TaskOrchestrator } from "../../src/task/orchestrator.js";
import {
  FakeAgentTurn,
  FakeMachineEnvironment,
  type AgentTurn,
  type AgentTurnInput,
  type MachineEnvironment,
} from "../../src/agentturn/index.js";
import type { AppConfig } from "../../src/config.js";
import type {
  SetupEnvironment,
  SetupProfile,
} from "../../src/setup/profile.js";
import type { SetupStore } from "../../src/setup/store.js";
import type {
  ClaimedTurn,
  NewTaskRecord,
  TaskRecord,
  TaskStatus,
  ThreadMessage,
  ThreadRef,
} from "../../src/types.js";

const TEST_WORKSPACE_ROOT = join(process.cwd(), "test", "tmp", "workspaces");

export const config: AppConfig = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "token",
  GITHUB_TOKEN: "github",
  WORKSPACE_ROOT: TEST_WORKSPACE_ROOT,
  MAX_CONCURRENT_TASKS: 1,
  AGENT_MAX_TOOL_FAILURES: 10,
  AGENT_MAX_VALIDATION_FAILURES: 3,
  AGENT_SUBMISSION_MAX_ATTEMPTS: 2,
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
  getProfile: async () => readyProfile,
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
  private breakTransition = false;
  private readonly reserved = new Set<string>();

  constructor(private readonly maxConcurrent: number) {}

  /** Simulate a concurrent cancel committing between read and transition. */
  breakNextTransition(): void {
    this.breakTransition = true;
  }

  /** Release a reserved claim without committing the turn. */
  releaseReservation(taskId: string): void {
    this.reserved.delete(taskId);
  }

  /** Commit a reserved claim: move the task to running and consume the followup. */
  async commitTurn(claimed: ClaimedTurn): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(claimed.task.id);
    if (!task) return undefined;
    if (!["queued", "waiting"].includes(task.status)) return undefined;

    if (claimed.source === "followup") {
      const idx = this.followups.findIndex(
        (f) =>
          f.taskId === claimed.task.id &&
          f.discordMessageId === claimed.initiatorMessageId,
      );
      if (idx === -1) return undefined;
      this.followups.splice(idx, 1);
    }

    task.status = "running";
    if (claimed.source === "initial") {
      task.initialTurnStarted = true;
    }
    this.reserved.delete(task.id);
    return clone(task);
  }

  snapshot(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    return clone(task);
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

  async getById(taskId: string): Promise<TaskRecord | undefined> {
    return clone(this.tasks.get(taskId));
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
    headerMessageId?: string,
  ): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "draft") return undefined;
    task.discordThreadId = threadId;
    task.flueInstanceId = flueInstanceId;
    task.progressMessageIds = [statusMessageId];
    if (headerMessageId) task.headerMessageId = headerMessageId;
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
    const active =
      [...this.tasks.values()].filter((t) => t.status === "running").length +
      this.reserved.size;
    if (active >= this.maxConcurrent) return undefined;

    const claimed =
      this.claimFollowup(preferTaskId) ??
      this.claimInitial(preferTaskId) ??
      this.claimFollowup(undefined);
    if (claimed) {
      this.reserved.add(claimed.task.id);
    }
    return claimed;
  }

  async queueSnapshot(
    taskId: string,
  ): Promise<{ position: number; depth: number }> {
    const target = this.tasks.get(taskId);
    const queued = [...this.tasks.values()].filter(
      (t) => t.status === "queued",
    );
    if (!target) return { position: 0, depth: queued.length };
    return {
      position: queued.filter((t) => t.createdAt <= target.createdAt).length,
      depth: queued.length,
    };
  }

  async transition(
    taskId: string,
    from: TaskStatus | TaskStatus[],
    to: TaskStatus,
    errorSummary?: string,
  ): Promise<TaskRecord | undefined> {
    if (this.breakTransition && to === "waiting") {
      this.breakTransition = false;
      const task = this.tasks.get(taskId);
      if (task) task.status = "cancelled";
      return undefined;
    }
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
    this.reserved.delete(taskId);
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
    this.reserved.clear();
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
          !this.reserved.has(t.id) &&
          (preferTaskId === undefined || t.id === preferTaskId),
      )
      .sort(byCreatedThenId)[0];
    if (!candidate) return undefined;
    return {
      task: clone(candidate),
      instruction: candidate.instruction,
      source: "initial",
      initiatorMessageId: candidate.discordMessageId,
    };
  }

  private claimFollowup(preferTaskId?: string): ClaimedTurn | undefined {
    const followup = this.followups
      .filter((f) => {
        const task = this.tasks.get(f.taskId);
        return (
          task?.status === "waiting" &&
          !this.reserved.has(task.id) &&
          task.initialTurnStarted &&
          (preferTaskId === undefined || task.id === preferTaskId)
        );
      })
      .sort((a, b) => a.seq - b.seq)[0];
    if (!followup) return undefined;
    return {
      task: clone(this.tasks.get(followup.taskId)!),
      instruction: followup.instruction,
      source: "followup",
      initiatorMessageId: followup.discordMessageId,
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
  headerSend?: boolean;
  headerPin?: boolean;
  headerEdit?: boolean;
  reactionFail?: boolean;
  typingFail?: boolean;
}

export interface ReactionRecordings {
  reactCalls: string[];
  unreactCalls: string[];
  reactionLog: string[];
}

export interface RecordingControlMessage extends ReactionRecordings {
  id: string;
  replies: string[];
}
export interface RecordingFollowupMessage
  extends ThreadMessage, ReactionRecordings {
  replies: string[];
}
export interface RecordingThread extends ThreadRef {
  sends: string[];
  pins: string[];
  edits: { messageId: string; content: string }[];
  sendTypingCalls: number;
}

export interface SubmitResult {
  task: TaskRecord | undefined;
  replies: string[];
  sends: string[];
  threadsCreated: number;
  message: RecordingControlMessage;
  thread: RecordingThread;
}

export interface WorldOverrides {
  machineEnvironment?: MachineEnvironment;
  setupStore?: SetupStore;
}

export class World {
  readonly store: InMemoryStore;
  readonly orchestrator: TaskOrchestrator;
  readonly fakeAgentTurn: FakeAgentTurn;
  readonly fakeMachineEnvironment: FakeMachineEnvironment;
  readonly dispatched: string[] = [];
  private counter = 0;

  constructor(
    maxConcurrent = config.MAX_CONCURRENT_TASKS,
    typingIntervalMs = 9000,
    overrides: WorldOverrides = {},
  ) {
    this.store = new InMemoryStore(maxConcurrent);
    this.fakeAgentTurn = new FakeAgentTurn({
      maxConcurrency: maxConcurrent,
      // The orchestrator posts its own restart notices; avoid duplicating them.
      enableRestartNotifications: false,
      onPrompt: (input) => {
        this.dispatched.push(input.instanceId);
      },
    });
    this.fakeMachineEnvironment = new FakeMachineEnvironment();
    this.orchestrator = new TaskOrchestrator(
      { ...config, MAX_CONCURRENT_TASKS: maxConcurrent },
      this.store as unknown as import("../../src/task/store.js").TaskStore,
      overrides.setupStore ?? fakeSetupStore,
      this.fakeAgentTurn,
      overrides.machineEnvironment ?? this.fakeMachineEnvironment,
      typingIntervalMs,
    );
  }

  blockNextPrompt(): { release: () => void } {
    return this.fakeAgentTurn.blockNextPrompt();
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
    const pins: string[] = [];
    const edits: { messageId: string; content: string }[] = [];
    let threadsCreated = 0;

    const thread: RecordingThread = {
      id: threadId,
      sends,
      pins,
      edits,
      sendTypingCalls: 0,
      send: async (content) => {
        if (failure.headerSend && content.includes("**Threadcord task**")) {
          throw new Error("discord: header send 500");
        }
        if (failure.statusSend) throw new Error("discord: status send 500");
        sends.push(content);
        return { id: `status-${this.counter++}` };
      },
      pin: async (messageId) => {
        if (failure.headerPin) throw new Error("discord: header pin 500");
        pins.push(messageId);
      },
      editMessage: async (messageId, content) => {
        if (failure.headerEdit) throw new Error("discord: header edit 500");
        edits.push({ messageId, content });
      },
      sendTyping: async () => {
        if (failure.typingFail) throw new Error("discord: sendTyping 403");
        thread.sendTypingCalls += 1;
      },
      setName: async () => {},
    };

    const message: RecordingControlMessage = {
      id: messageId,
      replies,
      reactCalls: [],
      unreactCalls: [],
      reactionLog: [],
    };

    const result = await this.orchestrator.startTaskFromSlash({
      initiatorMessageId: messageId,
      pending: {
        repo: "acme/web",
        branch: "main",
        instruction: "Do the work",
        model: config.defaultModel,
      },
      createThread: async () => {
        if (failure.createThread) throw new Error("discord: thread create 500");
        threadsCreated += 1;
        return thread;
      },
    });
    if (!result.ok) {
      replies.push(result.reason);
    }
    await flush();
    return {
      task: this.store.findByMessageId(messageId),
      replies,
      sends,
      threadsCreated,
      message,
      thread,
    };
  }

  async submitFollowup(
    taskId: string,
    followupMessageId: string,
    content = "fix the tests",
  ): Promise<{ message: RecordingFollowupMessage; replies: string[] }> {
    const task = this.store.snapshot(taskId);
    const replies: string[] = [];
    const message: RecordingFollowupMessage = {
      id: followupMessageId,
      content,
      authorBot: false,
      channelId: task.discordThreadId,
      replies,
      reactCalls: [],
      unreactCalls: [],
      reactionLog: [],
      reply: async (c) => {
        replies.push(c);
      },
      react: async (emoji) => {
        message.reactCalls.push(emoji);
        message.reactionLog.push(`react:${emoji}`);
      },
      unreact: async (emoji) => {
        message.unreactCalls.push(emoji);
        message.reactionLog.push(`unreact:${emoji}`);
      },
    };
    await this.orchestrator.handleThreadMessage(message);
    await flush();
    return { message, replies };
  }

  async sendThreadMessage(
    taskId: string,
    messageId: string,
    content: string,
  ): Promise<RecordingFollowupMessage> {
    const task = this.store.snapshot(taskId);
    const message: RecordingFollowupMessage = {
      id: messageId,
      content,
      authorBot: false,
      channelId: task.discordThreadId,
      replies: [],
      reactCalls: [],
      unreactCalls: [],
      reactionLog: [],
      reply: async (c) => {
        message.replies.push(c);
      },
      react: async (emoji) => {
        message.reactCalls.push(emoji);
        message.reactionLog.push(`react:${emoji}`);
      },
      unreact: async (emoji) => {
        message.unreactCalls.push(emoji);
        message.reactionLog.push(`unreact:${emoji}`);
      },
    };
    await this.orchestrator.handleThreadMessage(message);
    await flush();
    return message;
  }

  async restart(
    notifyThread?: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    await this.orchestrator.resumeAfterRestart(
      notifyThread ?? (async () => {}),
    );
    await flush();
  }
}

export async function flush(): Promise<void> {
  // setTimeout(0) lets poll block for threadpool I/O (the mocked bootstrap
  // mkdir); setImmediate alone busy-spins past it and stalls runTurn on CI.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
