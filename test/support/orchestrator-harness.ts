import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { JobWithMetadata } from "pg-boss";
import {
  TaskOrchestrator,
  type BootstrapTurn,
  type DispatchTurn,
} from "../../src/task/orchestrator.js";
import type { AppConfig } from "../../src/config.js";
import type {
  SetupEnvironment,
  SetupProfile,
} from "../../src/setup/profile.js";
import type { SetupStore } from "../../src/setup/store.js";
import type { ViewPayload } from "../../src/discord/ui/index.js";
import { buildCustomId } from "../../src/discord/ui/index.js";
import type { TaskThreadRef } from "../../src/task/discord-thread.js";
import type {
  NewTaskRecord,
  TaskRecord,
  TaskStatus,
  TaskTurnRecord,
  ThreadMessage,
  ThreadRef,
  TurnStatus,
} from "../../src/types.js";
import type { TurnStore } from "../../src/task/turn-store.js";
import type { TurnJobData } from "../../src/task/turn-executor.js";
import { executeTurnJob } from "../../src/task/turn-executor.js";
import { TASK_TURN_QUEUE } from "../../src/task/boss.js";
import type { Pool, PoolClient } from "pg";

const TEST_WORKSPACE_ROOT = join(process.cwd(), "test", "tmp", "workspaces");

export const config: AppConfig = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "token",
  DISCORD_CHANNEL_ID: "control-channel",
  GITHUB_TOKEN: "github",
  WORKSPACE_ROOT: TEST_WORKSPACE_ROOT,
  MAX_CONCURRENT_TASKS: 1,
  QUEUE_RETRY_LIMIT: 3,
  QUEUE_RETRY_DELAY_SECONDS: 30,
  QUEUE_RETRY_DELAY_MAX_SECONDS: 300,
  QUEUE_EXPIRE_IN_SECONDS: 7200,
  QUEUE_HEARTBEAT_SECONDS: 60,
  TURN_RETENTION_DAYS: 14,
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

  constructor(private readonly maxConcurrent: number) {}

  /** Simulate a concurrent cancel committing between read and transition. */
  breakNextTransition(): void {
    this.breakTransition = true;
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

  runningCount(): number {
    return [...this.tasks.values()].filter((t) => t.status === "running")
      .length;
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
    this.followups = this.followups.filter((f) => f.taskId !== taskId);
    return clone(task);
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

// ---------------------------------------------------------------------------
// In-memory TurnStore double (mirrors src/task/turn-store.ts semantics)
// ---------------------------------------------------------------------------

interface StoredTurn {
  id: string;
  taskId: string;
  source: "initial" | "followup";
  instruction: string;
  discordMessageId?: string;
  status: TurnStatus;
  attemptCount: number;
  cancelRequestedAt?: Date;
  lastError?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
}

const TERMINAL_TURN_STATUSES: readonly TurnStatus[] = [
  "cancelled",
  "completed",
  "failed",
];

export class InMemoryTurnStore {
  private readonly turns = new Map<string, StoredTurn>();
  /** When true, the next insertTurn simulates a duplicate (ON CONFLICT). */
  duplicateNextInsert = false;

  async insertTurn(
    turn: {
      id: string;
      taskId: string;
      source: "initial" | "followup";
      instruction: string;
      discordMessageId?: string;
    },
    client?: PoolClient,
  ): Promise<{ created: boolean }> {
    if (this.duplicateNextInsert) {
      this.duplicateNextInsert = false;
      return { created: false };
    }
    if (turn.discordMessageId) {
      for (const existing of this.turns.values()) {
        if (existing.discordMessageId === turn.discordMessageId) {
          return { created: false };
        }
      }
    }
    const now = new Date();
    this.turns.set(turn.id, {
      id: turn.id,
      taskId: turn.taskId,
      source: turn.source,
      instruction: turn.instruction,
      ...(turn.discordMessageId
        ? { discordMessageId: turn.discordMessageId }
        : {}),
      status: "queued",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    // Mirror Postgres: a rolled-back transaction must not leave the turn.
    if (client && hasRollbackHook(client)) {
      client.onRollback(() => {
        this.turns.delete(turn.id);
      });
    }
    return { created: true };
  }

  async claimQueuedTurn(
    turnId: string,
  ): Promise<TaskTurnRecord | undefined> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.status !== "queued" || turn.cancelRequestedAt) {
      return undefined;
    }
    turn.status = "running";
    turn.attemptCount += 1;
    turn.startedAt ??= new Date();
    turn.updatedAt = new Date();
    return this.toRecord(turn);
  }

  async resumeTurnForExecution(turnId: string): Promise<boolean> {
    const turn = this.turns.get(turnId);
    if (!turn) return false;
    if (turn.status === "queued" && !turn.cancelRequestedAt) {
      turn.status = "running";
      turn.attemptCount += 1;
      turn.startedAt ??= new Date();
      turn.updatedAt = new Date();
      return true;
    }
    return turn.status === "running" && !turn.cancelRequestedAt;
  }

  async markTurnCompleted(turnId: string): Promise<boolean> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.status !== "running" || turn.cancelRequestedAt) {
      return false;
    }
    turn.status = "completed";
    turn.completedAt = new Date();
    turn.updatedAt = new Date();
    return true;
  }

  async markTurnFailed(turnId: string, lastError: string): Promise<boolean> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.status !== "running" || turn.cancelRequestedAt) {
      return false;
    }
    turn.status = "failed";
    turn.lastError = lastError;
    turn.completedAt = new Date();
    turn.updatedAt = new Date();
    return true;
  }

  async markTurnRetrying(turnId: string, lastError: string): Promise<boolean> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.status !== "running" || turn.cancelRequestedAt) {
      return false;
    }
    turn.status = "queued";
    turn.lastError = lastError;
    turn.updatedAt = new Date();
    return true;
  }

  async requestCancel(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.cancelRequestedAt ??= new Date();
    turn.updatedAt = new Date();
  }

  async markTurnCancelled(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    if (turn.status === "queued" || turn.status === "running") {
      turn.status = "cancelled";
      turn.completedAt ??= new Date();
      turn.updatedAt = new Date();
    }
  }

  async cancelPendingTurnsForTask(
    taskId: string,
    _client?: PoolClient,
  ): Promise<string[]> {
    const cancelled: string[] = [];
    for (const turn of this.turns.values()) {
      if (turn.taskId === taskId && turn.status === "queued") {
        turn.status = "cancelled";
        turn.completedAt ??= new Date();
        turn.updatedAt = new Date();
        cancelled.push(turn.id);
      }
    }
    return cancelled;
  }

  async shouldSkipTurn(turnId: string): Promise<boolean> {
    const turn = this.turns.get(turnId);
    if (!turn) return true;
    if (
      (TERMINAL_TURN_STATUSES as readonly string[]).includes(turn.status)
    ) {
      return true;
    }
    return turn.cancelRequestedAt !== undefined;
  }

  async getTurn(turnId: string): Promise<TaskTurnRecord | undefined> {
    const turn = this.turns.get(turnId);
    return turn ? this.toRecord(turn) : undefined;
  }

  async listRunningTurns(): Promise<TaskTurnRecord[]> {
    return [...this.turns.values()]
      .filter((t) => t.status === "running")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((t) => this.toRecord(t));
  }

  async listQueuedTurns(): Promise<TaskTurnRecord[]> {
    return [...this.turns.values()]
      .filter((t) => t.status === "queued")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((t) => this.toRecord(t));
  }

  async requeueInterruptedTurn(turnId: string): Promise<boolean> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.status !== "running") return false;
    turn.status = "queued";
    turn.updatedAt = new Date();
    return true;
  }

  async deleteAgedTerminalTurns(
    retentionDays: number,
    batchSize: number,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const terminal = [...this.turns.values()]
      .filter(
        (t) =>
          (t.status === "completed" ||
            t.status === "failed" ||
            t.status === "cancelled") &&
          t.updatedAt < cutoff,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, batchSize);
    for (const turn of terminal) {
      this.turns.delete(turn.id);
    }
    return terminal.length;
  }

  /** Test helper: seed a turn directly. */
  seedTurn(turn: StoredTurn): void {
    this.turns.set(turn.id, { ...turn });
  }

  /** Test helper: get a snapshot of a turn. */
  snapshotTurn(turnId: string): TaskTurnRecord | undefined {
    const turn = this.turns.get(turnId);
    return turn ? this.toRecord(turn) : undefined;
  }

  private toRecord(turn: StoredTurn): TaskTurnRecord {
    return {
      id: turn.id,
      taskId: turn.taskId,
      source: turn.source,
      instruction: turn.instruction,
      ...(turn.discordMessageId
        ? { discordMessageId: turn.discordMessageId }
        : {}),
      status: turn.status,
      attemptCount: turn.attemptCount,
      ...(turn.cancelRequestedAt
        ? { cancelRequestedAt: turn.cancelRequestedAt }
        : {}),
      ...(turn.lastError ? { lastError: turn.lastError } : {}),
      createdAt: turn.createdAt,
      ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
      ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
      updatedAt: turn.updatedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// FakeBoss — in-memory pg-boss double
// ---------------------------------------------------------------------------

interface RecordedJob {
  id: string;
  queue: string;
  data: TurnJobData;
  options: Record<string, unknown>;
  retryCount: number;
  retryLimit: number;
  state: "created" | "retry" | "active" | "completed" | "cancelled" | "failed";
}

export class FakeBoss {
  private jobs: RecordedJob[] = [];
  private deliveredIds = new Set<string>();
  private workHandler?:
    | ((jobs: JobWithMetadata<TurnJobData>[]) => Promise<void>)
    | undefined;
  readonly cancelCalls: Array<[string, string | string[]]> = [];
  readonly rethrownJobs: { jobId: string; error: unknown }[] = [];
  /** When true, the next send() returns null (intake atomicity test). */
  nullOnNextSend = false;

  async send(
    queue: string,
    data: TurnJobData,
    options: Record<string, unknown> = {},
  ): Promise<string | null> {
    if (this.nullOnNextSend) {
      this.nullOnNextSend = false;
      return null;
    }
    const id = `job-${this.jobs.length + 1}`;
    const retryLimit =
      (options.retryLimit as number | undefined) ??
      config.QUEUE_RETRY_LIMIT;
    this.jobs.push({
      id,
      queue,
      data,
      options,
      retryCount: 0,
      retryLimit,
      state: "created",
    });
    return id;
  }

  async work(
    _queue: string,
    _options: Record<string, unknown>,
    handler: (jobs: JobWithMetadata<TurnJobData>[]) => Promise<void>,
  ): Promise<void> {
    this.workHandler = handler;
  }

  async cancel(queue: string, id: string | string[]): Promise<void> {
    this.cancelCalls.push([queue, id]);
    const ids = Array.isArray(id) ? id : [id];
    for (const jobId of ids) {
      const job = this.jobs.find((j) => j.id === jobId);
      if (job && job.state !== "completed" && job.state !== "failed") {
        job.state = "cancelled";
      }
    }
  }

  async findJobs<T = TurnJobData>(
    queue: string,
    options: { key?: string; id?: string; queued?: boolean } = {},
  ): Promise<JobWithMetadata<T>[]> {
    return this.jobs
      .filter((j) => {
        if (j.queue !== queue) return false;
        if (options.id && j.id !== options.id) return false;
        if (options.key && j.options.singletonKey !== options.key) return false;
        if (options.queued && j.state >= "active") return false;
        return true;
      })
      .map((j) => ({
        id: j.id,
        name: j.queue,
        data: j.data as T,
        state: j.state,
        retryCount: j.retryCount,
        retryLimit: j.retryLimit,
      })) as JobWithMetadata<T>[];
  }

  get sentJobs(): readonly RecordedJob[] {
    return this.jobs;
  }

  get pendingJobs(): RecordedJob[] {
    return this.jobs.filter((j) => !this.deliveredIds.has(j.id));
  }

  /**
   * Claim the next pending job (or a specific one by id), mark it delivered,
   * and return a JobWithMetadata ready for the work handler. Returns undefined
   * if no pending job exists.
   */
  claimNextJob(
    jobId?: string,
    retryCount?: number,
  ): { job: JobWithMetadata<TurnJobData>; recorded: RecordedJob } | undefined {
    let recorded: RecordedJob | undefined;
    if (jobId) {
      recorded = this.jobs.find((j) => j.id === jobId);
    } else {
      recorded = this.pendingJobs[0];
    }
    if (!recorded) return undefined;
    this.deliveredIds.add(recorded.id);
    const job: JobWithMetadata<TurnJobData> = {
      id: recorded.id,
      name: recorded.queue,
      data: recorded.data,
      retryCount: retryCount ?? recorded.retryCount,
      retryLimit: recorded.retryLimit,
    } as JobWithMetadata<TurnJobData>;
    return { job, recorded };
  }

  recordRethrow(jobId: string, error: unknown): void {
    this.rethrownJobs.push({ jobId, error });
  }

  get workHandlerFn():
    | ((jobs: JobWithMetadata<TurnJobData>[]) => Promise<void>)
    | undefined {
    return this.workHandler;
  }
}

// ---------------------------------------------------------------------------
// FakePool / FakePoolClient — satisfy inTransaction without a real database
// ---------------------------------------------------------------------------

class FakePoolClient {
  private rollbackCallbacks: Array<() => void> = [];

  constructor(private readonly pool: FakePool) {}

  onRollback(callback: () => void): void {
    this.rollbackCallbacks.push(callback);
  }

  async query(text = ""): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = text.trim().toUpperCase();
    if (sql === "BEGIN") {
      this.rollbackCallbacks = [];
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      // Clear first so a post-COMMIT error cannot undo durable work via
      // the catch-path ROLLBACK in inTransaction (ambiguous commit ack).
      this.rollbackCallbacks = [];
      if (this.pool.throwOnNextCommit) {
        this.pool.throwOnNextCommit = false;
        throw new Error("commit acknowledgment failed");
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      for (const callback of this.rollbackCallbacks.splice(0)) {
        callback();
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

function hasRollbackHook(
  client: PoolClient,
): client is PoolClient & { onRollback(callback: () => void): void } {
  return typeof (client as { onRollback?: unknown }).onRollback === "function";
}

export class FakePool {
  /** When true, the next COMMIT clears rollbacks then throws (ambiguous ack). */
  throwOnNextCommit = false;

  async connect(): Promise<FakePoolClient> {
    return new FakePoolClient(this);
  }
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
  viewReplies: ViewPayload[];
  viewEdits: ViewPayload[];
  authorId?: string | undefined;
  replyView?: (payload: ViewPayload) => Promise<void>;
  replyQuote?:
    | import("../../src/types.js").ThreadMessageReplyQuote
    | undefined;
}
export interface RecordingThread extends TaskThreadRef {
  sends: string[];
  viewSends: ViewPayload[];
  pins: string[];
  edits: { messageId: string; content: string }[];
  viewEdits: { messageId: string; payload: ViewPayload }[];
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
  dispatch?: DispatchTurn;
  bootstrap?: BootstrapTurn;
}

export class World {
  readonly store: InMemoryStore;
  readonly turnStore: InMemoryTurnStore;
  readonly boss: FakeBoss;
  readonly pool: FakePool;
  readonly orchestrator: TaskOrchestrator;
  readonly dispatched: string[] = [];
  private readonly maxConcurrent: number;
  private counter = 0;

  constructor(
    maxConcurrent = config.MAX_CONCURRENT_TASKS,
    typingIntervalMs = 9000,
    overrides: WorldOverrides = {},
  ) {
    this.maxConcurrent = maxConcurrent;
    this.store = new InMemoryStore(maxConcurrent);
    this.turnStore = new InMemoryTurnStore();
    this.boss = new FakeBoss();
    this.pool = new FakePool();
    this.orchestrator = new TaskOrchestrator(
      { ...config, MAX_CONCURRENT_TASKS: maxConcurrent },
      this.store as unknown as import("../../src/task/store.js").TaskStore,
      fakeSetupStore,
      overrides.dispatch ??
        (async (instanceId: string) => {
          this.dispatched.push(instanceId);
        }),
      overrides.bootstrap ??
        (async (task) => {
          const path = join(TEST_WORKSPACE_ROOT, task.id);
          await mkdir(path, { recursive: true });
          return path;
        }),
      async () => {},
      typingIntervalMs,
      {
        boss: this.boss as unknown as import("pg-boss").PgBoss,
        turnStore: this.turnStore as unknown as TurnStore,
        pool: this.pool as unknown as Pool,
      },
    );
    // Register the turn worker (mirrors app.ts wiring).
    const turnExecutorDeps = this.orchestrator.getTurnExecutorDeps();
    void this.boss.work(
      TASK_TURN_QUEUE,
      { localConcurrency: maxConcurrent },
      async (jobs: JobWithMetadata<TurnJobData>[]) => {
        const job = jobs[0];
        if (!job) return;
        await executeTurnJob(turnExecutorDeps, job);
      },
    );
  }

  threadIdFor(messageId: string): string {
    return `thread-${messageId}`;
  }

  /**
   * Deliver the next pending pg-boss job (or a specific one by id) to the
   * registered turn worker. The executor runs in the background (fire-and-
   * forget) so it can suspend at `waitForTurnOutcome` until the test resolves
   * the outcome via `handleAgentEnd`/`handleAgentFailure`. Returns true if a
   * job was delivered.
   */
  async deliver(
    options?: {
      retryCount?: number;
      jobId?: string;
      forceRedeliver?: boolean;
    },
  ): Promise<boolean> {
    const handler = this.boss.workHandlerFn;
    if (!handler) return false;
    let job: JobWithMetadata<TurnJobData> | undefined;
    let recordedId: string | undefined;
    if (options?.forceRedeliver && options.jobId) {
      const recorded = this.boss.sentJobs.find((j) => j.id === options.jobId);
      if (!recorded) return false;
      job = {
        id: recorded.id,
        name: recorded.queue,
        data: recorded.data,
        retryCount: options.retryCount ?? 0,
        retryLimit: recorded.retryLimit,
      } as JobWithMetadata<TurnJobData>;
      recordedId = recorded.id;
    } else {
      const claimed = this.boss.claimNextJob(
        options?.jobId,
        options?.retryCount,
      );
      if (!claimed) return false;
      job = claimed.job;
      recordedId = claimed.recorded.id;
    }
    void handler([job]).catch((err) => {
      this.boss.recordRethrow(recordedId!, err);
    });
    await flush();
    return true;
  }

  /**
   * Auto-deliver pending jobs while there are free concurrency slots,
   * simulating pg-boss's localConcurrency scheduling without timers.
   */
  private async autoDeliver(): Promise<void> {
    while (this.store.runningCount() < this.maxConcurrent) {
      const delivered = await this.deliver();
      if (!delivered) break;
    }
  }

  async submitRaw(
    messageId: string,
    failure: ThreadFailure = {},
    options?: { autoDeliver?: boolean },
  ): Promise<SubmitResult> {
    const threadId = this.threadIdFor(messageId);
    const replies: string[] = [];
    const sends: string[] = [];
    const viewSends: ViewPayload[] = [];
    const pins: string[] = [];
    const edits: { messageId: string; content: string }[] = [];
    const viewEdits: { messageId: string; payload: ViewPayload }[] = [];
    let threadsCreated = 0;

    const thread: RecordingThread = {
      id: threadId,
      sends,
      viewSends,
      pins,
      edits,
      viewEdits,
      sendTypingCalls: 0,
      sendView: async (payload) => {
        if (failure.headerSend && isTaskHeaderPayload(payload)) {
          throw new Error("discord: header send 500");
        }
        viewSends.push(payload);
        return { id: `header-${this.counter++}` };
      },
      send: async (content) => {
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
      editView: async (messageId, payload) => {
        if (failure.headerEdit) throw new Error("discord: header edit 500");
        viewEdits.push({ messageId, payload });
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
    if (options?.autoDeliver ?? true) {
      await this.autoDeliver();
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

  async submitChannelMessage(
    messageId: string,
    content: string,
    options: {
      attachments?: import("../../src/types.js").ThreadMessageAttachment[];
      channelId?: string;
      failure?: ThreadFailure;
      autoDeliver?: boolean;
    } = {},
  ): Promise<SubmitResult> {
    const threadId = this.threadIdFor(messageId);
    const replies: string[] = [];
    const sends: string[] = [];
    const viewSends: ViewPayload[] = [];
    const pins: string[] = [];
    const edits: { messageId: string; content: string }[] = [];
    const viewEdits: { messageId: string; payload: ViewPayload }[] = [];
    let threadsCreated = 0;
    const failure = options.failure ?? {};

    const thread: RecordingThread = {
      id: threadId,
      sends,
      viewSends,
      pins,
      edits,
      viewEdits,
      sendTypingCalls: 0,
      sendView: async (payload) => {
        if (failure.headerSend && isTaskHeaderPayload(payload)) {
          throw new Error("discord: header send 500");
        }
        viewSends.push(payload);
        return { id: `header-${this.counter++}` };
      },
      send: async (content) => {
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
      editView: async (messageId, payload) => {
        if (failure.headerEdit) throw new Error("discord: header edit 500");
        viewEdits.push({ messageId, payload });
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

    await this.orchestrator.handleChannelMessage({
      id: messageId,
      content,
      authorBot: false,
      channelId: options.channelId ?? config.DISCORD_CHANNEL_ID!,
      attachments: options.attachments,
      createThread: async () => {
        if (failure.createThread) throw new Error("discord: thread create 500");
        threadsCreated += 1;
        return thread;
      },
      reply: async (replyContent) => {
        replies.push(replyContent);
      },
      react: async (emoji) => {
        message.reactCalls.push(emoji);
        message.reactionLog.push(`react:${emoji}`);
      },
      unreact: async (emoji) => {
        message.unreactCalls.push(emoji);
        message.reactionLog.push(`unreact:${emoji}`);
      },
    });
    if (options.autoDeliver ?? true) {
      await this.autoDeliver();
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
    replyQuote?: import("../../src/types.js").ThreadMessageReplyQuote,
  ): Promise<{ message: RecordingFollowupMessage; replies: string[] }> {
    const task = this.store.snapshot(taskId);
    const replies: string[] = [];
    const viewReplies: ViewPayload[] = [];
    const message: RecordingFollowupMessage = {
      id: followupMessageId,
      content,
      authorBot: false,
      channelId: task.discordThreadId,
      replyQuote,
      replies,
      viewReplies,
      viewEdits: [],
      reactCalls: [],
      unreactCalls: [],
      reactionLog: [],
      reply: async (c) => {
        replies.push(c);
      },
      replyView: async (payload) => {
        viewReplies.push(payload);
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
    await this.autoDeliver();
    await flush();
    return { message, replies };
  }

  async sendThreadMessage(
    taskId: string,
    messageId: string,
    content: string,
  ): Promise<RecordingFollowupMessage> {
    return this.sendControlMessage(taskId, messageId, content);
  }

  async sendControlMessage(
    taskId: string,
    messageId: string,
    content: string,
    opts: { authorId?: string } = {},
  ): Promise<RecordingFollowupMessage> {
    const task = this.store.snapshot(taskId);
    const message: RecordingFollowupMessage = {
      id: messageId,
      content,
      authorBot: false,
      channelId: task.discordThreadId,
      authorId: opts.authorId,
      replies: [],
      viewReplies: [],
      viewEdits: [],
      reactCalls: [],
      unreactCalls: [],
      reactionLog: [],
      reply: async (c) => {
        message.replies.push(c);
      },
      replyView: async (payload) => {
        message.viewReplies.push(payload);
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

  async clickControlButton(input: {
    customId: string;
    userId: string;
    message: RecordingFollowupMessage;
    updateThrows?: boolean;
    onDefer?: () => void;
  }): Promise<{ deferred: boolean }> {
    let deferred = false;
    await this.orchestrator.handleControlButton({
      customId: input.customId,
      userId: input.userId,
      defer: async () => {
        input.onDefer?.();
        deferred = true;
      },
      update: async (payload) => {
        if (input.updateThrows) {
          throw new Error("discord: control outcome update failed");
        }
        input.message.viewEdits.push(payload);
      },
      reply: async (payload) => {
        input.message.viewReplies.push(payload);
      },
    });
    return { deferred };
  }

  async confirmThreadControl(
    taskId: string,
    messageId: string,
    command: "abort" | "cancel" | "done",
    authorId = "user-1",
  ): Promise<RecordingFollowupMessage> {
    const message = await this.sendControlMessage(taskId, messageId, command, {
      authorId,
    });
    await this.clickControlButton({
      customId: buildCustomId(
        "task",
        "ctl",
        "confirm",
        command,
        authorId,
        taskId,
      ),
      userId: authorId,
      message,
    });
    await flush();
    return message;
  }

  async restart(
    notifyThread?: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    await this.orchestrator.resumeAfterRestart(
      notifyThread ?? (async () => {}),
    );
    await this.autoDeliver();
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

function isTaskHeaderPayload(payload: ViewPayload): boolean {
  const body = JSON.stringify(payload);
  return body.includes("Threadcord task");
}

export function viewPayloadText(payload: ViewPayload): string {
  return JSON.stringify(payload);
}

export function headerEditContainsState(
  thread: RecordingThread,
  state: string,
): boolean {
  return thread.viewEdits.some((edit) =>
    viewPayloadText(edit.payload).includes(`**State**: ${state}`),
  );
}
