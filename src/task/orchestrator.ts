import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dispatch } from "@flue/runtime";
import { failureDiscordMessage } from "../discord/observe-bridge.js";
import { formatTaskInstructionForDiscord } from "../discord/task-instruction-message.js";
import { renderTaskHeader } from "../discord/task-header.js";
import type { ViewPayload } from "../discord/ui/index.js";
import { errorView } from "../discord/ui/index.js";
import { takePendingUserTurnMessages } from "../discord/user-turn-message.js";
import type { AppConfig } from "../config.js";
import { resolveTaskRequest } from "../config.js";
import codingAgent from "../agents/coding.js";
import {
  isPendingThreadId,
  pendingThreadId,
  toFlueInstanceId,
} from "../ids.js";
import { bootstrapWorkspace, runSetupInstall } from "./bootstrap.js";
import type { BootstrapMode } from "./bootstrap.js";
import type { PendingTaskCreate } from "./create-flow.js";
import { parseTaskMessage } from "./parser.js";
import { validateTaskPolicy } from "./policy.js";
import type { TaskStore } from "./store.js";
import type { SetupStore } from "../setup/store.js";
import { summarizeError } from "../util/redact.js";
import {
  scheduleReadableThreadRename,
  type RenameDiscordThread,
} from "./rename-thread.js";
import {
  parseThreadControlCommand,
  stopTaskWork,
} from "./abort-thread-task.js";
import type { TaskThreadRef } from "./discord-thread.js";
import {
  buildThreadControlConfirmView,
  controlOutcomeView,
  controlPrompt,
  dismissedControlView,
  parseThreadControlButtonCustomId,
  type ThreadControlCommand,
} from "./thread-controls.js";
import { threadName } from "./thread-name.js";
import type {
  ChannelMessage,
  DispatchAgentInput,
  TaskRecord,
  TaskRequest,
  TaskStatus,
  TaskTurnRecord,
  ThreadMessage,
  ThreadMessageAttachment,
  ThreadMessageReplyQuote,
} from "../types.js";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { inTransaction, pgBossDb } from "../db.js";
import { TASK_TURN_QUEUE, releaseTaskSingleton } from "./boss.js";
import { resolveTurnOutcome } from "./turn-completion.js";
import type { TurnStore } from "./turn-store.js";
import type {
  TurnExecutorDeps,
  TurnExecutorHooks,
  TurnJobData,
} from "./turn-executor.js";

export type StartTaskFromSlashResult =
  | { ok: false; reason: string }
  | { ok: true; threadId: string; startedImmediately: boolean };

export interface StartTaskFromSlashInput {
  initiatorMessageId: string;
  pending: PendingTaskCreate;
  createThread: (name: string) => Promise<TaskThreadRef>;
}

interface AdmitTaskInput {
  initiatorMessageId: string;
  taskRequest: TaskRequest;
  setupProfileRevision: number;
  createThread: (name: string) => Promise<TaskThreadRef>;
  recordInitiator: (taskId: string) => void;
  onAdmitted?: (() => void | Promise<void>) | undefined;
}

const EYES = "👀";
const CHECK = "✅";
const CROSS = "❌";
const TYPING_INTERVAL_MS = 9000;

interface ReactionTarget {
  react(emoji: string): Promise<void>;
  unreact(emoji: string): Promise<void>;
}

interface InFlightTurn {
  initiator?: ReactionTarget | undefined;
  typingTimer?: NodeJS.Timeout | undefined;
}

/** Sends one dispatched agent turn. Injectable so tests can fake the runtime. */
export type DispatchTurn = (
  instanceId: string,
  input: DispatchAgentInput,
) => Promise<void>;

/** Prepares a turn workspace checkout. Injectable so tests can skip git. */
export type BootstrapTurn = (
  task: TaskRecord,
  githubToken: string,
  mode: BootstrapMode,
) => Promise<string>;

/** Runs setup install on the initial turn. Injectable so tests can skip shell. */
export type RunSetupInstallTurn = (
  workspaceRoot: string,
  checkoutDir: string,
  installCommand: string,
  githubToken: string,
) => Promise<void>;

export type EditHeaderMessage = (
  threadId: string,
  messageId: string,
  payload: ViewPayload,
) => Promise<void>;

export interface TaskThreadMessage extends ThreadMessage {
  authorId?: string | undefined;
  replyView?: ((payload: ViewPayload) => Promise<void>) | undefined;
  /** Image attachments from the Discord message (filtered by content type). */
  attachments?: ThreadMessageAttachment[] | undefined;
  /** Content of the earlier message this message was a Discord reply to. */
  replyQuote?: ThreadMessageReplyQuote | undefined;
}

export interface HandleControlButtonInput {
  customId: string;
  userId: string;
  defer: () => Promise<void>;
  update: (payload: ViewPayload) => Promise<void>;
  reply: (payload: ViewPayload) => Promise<void>;
}

export type SendThreadTyping = (threadId: string) => Promise<void>;

const defaultDispatchTurn: DispatchTurn = async (instanceId, input) => {
  await dispatch(codingAgent, { id: instanceId, input });
};

const TERMINAL_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/** pg-boss queue wiring passed into the orchestrator for transactional intake. */
export interface TurnQueueDeps {
  boss: PgBoss;
  turnStore: TurnStore;
  pool: Pool;
}

export class TaskOrchestrator {
  private postMessage?: (threadId: string, content: string) => Promise<void>;
  private editHeaderMessage?: EditHeaderMessage;
  private sendThreadTyping?: SendThreadTyping;
  private renameDiscordThread?: RenameDiscordThread;
  private readonly taskThreads = new Map<string, TaskThreadRef>();
  private readonly initiatorMessages = new Map<string, ReactionTarget>();
  private readonly pendingInitiatorIds = new Map<string, Set<string>>();
  private readonly inFlightTurns = new Map<string, InFlightTurn>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: TaskStore,
    private readonly setupStore: SetupStore,
    private readonly dispatchTurn: DispatchTurn = defaultDispatchTurn,
    private readonly bootstrap: BootstrapTurn = bootstrapWorkspace,
    private readonly runSetupInstallTurn: RunSetupInstallTurn = runSetupInstall,
    private readonly typingIntervalMs: number = TYPING_INTERVAL_MS,
    private readonly queue?: TurnQueueDeps,
  ) {}

  /** Throw if the pg-boss queue was not wired (tests omit it). */
  private requireQueue(): TurnQueueDeps {
    if (!this.queue) {
      throw new Error("pg-boss queue not configured for this orchestrator");
    }
    return this.queue;
  }

  /** Build the dependency bundle the turn executor needs. */
  getTurnExecutorDeps(): TurnExecutorDeps {
    const queue = this.requireQueue();
    const hooks: TurnExecutorHooks = {
      beginTurn: (task, initiatorMessageId) =>
        this.beginTurn(task, initiatorMessageId),
      refreshHeader: async (taskId, runningTurn) => {
        await this.refreshHeader(taskId, runningTurn);
      },
      postToThread: (threadId, content) => this.post(threadId, content),
      startTypingLoopForTask: (task) => this.startTypingLoopForTask(task),
      scheduleRename: (threadId, instruction) =>
        this.scheduleRename(threadId, instruction),
      onTurnCompleted: (task) => this.onTurnCompleted(task),
      onTurnFailed: (task, errorSummary) =>
        this.onTurnFailed(task, errorSummary),
      clearInFlightState: (instanceId) => this.clearInFlight(instanceId),
    };
    return {
      turnStore: queue.turnStore,
      taskStore: this.store,
      setupStore: this.setupStore,
      config: this.config,
      dispatchTurn: this.dispatchTurn,
      bootstrap: this.bootstrap,
      runSetupInstallTurn: this.runSetupInstallTurn,
      hooks,
    };
  }

  setMilestonePublisher(
    postMessage: (threadId: string, content: string) => Promise<void>,
  ): void {
    this.postMessage = postMessage;
  }

  setHeaderPublisher(editHeaderMessage: EditHeaderMessage): void {
    this.editHeaderMessage = editHeaderMessage;
  }

  setTypingPublisher(sendThreadTyping: SendThreadTyping): void {
    this.sendThreadTyping = sendThreadTyping;
  }

  setThreadRenamer(renameDiscordThread: RenameDiscordThread): void {
    this.renameDiscordThread = renameDiscordThread;
  }

  async resumeAfterRestart(
    notifyThread: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    const { boss, turnStore } = this.requireQueue();

    // 1. Requeue turns stuck running (interrupted by a crash). The process
    //    just started, so no Flue submission is live.
    const runningTurns = await turnStore.listRunningTurns();
    for (const turn of runningTurns) {
      const task = await this.store.getById(turn.taskId);
      if (!task) continue;

      // Clear the dead job blocking the FIFO key for this task.
      await releaseTaskSingleton(boss, task.id);
      // Reset the turn: running → queued (attempt_count preserved).
      await turnStore.requeueInterruptedTurn(turn.id);
      // Transition the task: running → queued.
      await this.store.transition(task.id, "running", "queued");
      // Fresh boss.send for the requeued turn.
      const jobId = await boss.send(
        TASK_TURN_QUEUE,
        {
          turnId: turn.id,
          taskId: task.id,
          flueInstanceId: task.flueInstanceId,
          source: turn.source,
        },
        { singletonKey: task.id },
      );
      if (jobId === null) throw new Error("boss.send returned null for requeued turn");

      await this.refreshHeader(task.id);
      if (!isPendingThreadId(task.discordThreadId)) {
        try {
          await notifyThread(
            task.discordThreadId,
            "Restart detected. The interrupted turn was requeued.",
          );
        } catch (error) {
          console.error(
            `[threadcord] restart notification failed for task ${task.id} (thread ${task.discordThreadId}):`,
            summarizeError(error),
          );
        }
      }
    }

    // 2. Enqueue jobs for queued turns that have no boss job (covers plan
    //    003's backfilled follow-ups from the legacy task_followups table).
    const queuedTurns = await turnStore.listQueuedTurns();
    const turnsByTask = new Map<string, TaskTurnRecord[]>();
    for (const turn of queuedTurns) {
      const list = turnsByTask.get(turn.taskId);
      if (list) {
        list.push(turn);
      } else {
        turnsByTask.set(turn.taskId, [turn]);
      }
    }
    for (const [taskId, turns] of turnsByTask) {
      const jobs = await boss.findJobs<TurnJobData>(TASK_TURN_QUEUE, {
        key: taskId,
      });
      const representedTurnIds = new Set(
        jobs
          .filter(
            (j) =>
              j.state !== "cancelled" &&
              j.state !== "completed" &&
              j.state !== "failed",
          )
          .map((j) => j.data.turnId),
      );
      for (const turn of turns) {
        if (representedTurnIds.has(turn.id)) continue;
        const task = await this.store.getById(turn.taskId);
        if (!task) continue;
        const jobId = await boss.send(
          TASK_TURN_QUEUE,
          {
            turnId: turn.id,
            taskId: task.id,
            flueInstanceId: task.flueInstanceId,
            source: turn.source,
          },
          { singletonKey: task.id },
        );
        if (jobId === null) {
          throw new Error("boss.send returned null for orphaned queued turn");
        }
      }
    }

    // 3. Fail abandoned drafts (unchanged).
    await this.store.failAbandonedDrafts();
  }

  async startTaskFromSlash(
    input: StartTaskFromSlashInput,
  ): Promise<StartTaskFromSlashResult> {
    const request = resolveTaskRequest(
      {
        instruction: input.pending.instruction,
        repo: input.pending.repo,
        branch: input.pending.branch,
        model: input.pending.model,
      },
      this.config,
    );
    const policy = validateTaskPolicy(request, this.config);
    if (!policy.ok) {
      return { ok: false, reason: policy.reason };
    }
    const setupProfile = await this.setupStore.getReadyProfile(
      request.repo,
      request.branch,
    );
    if (!setupProfile) {
      return {
        ok: false,
        reason: `Missing ready setup profile for ${request.repo} on ${request.branch}. Run /setup create first.`,
      };
    }
    const taskRequest: TaskRequest = {
      ...request,
      repo: setupProfile.repo,
      branch: setupProfile.branch,
    };

    return this.admitTask({
      initiatorMessageId: input.initiatorMessageId,
      taskRequest,
      setupProfileRevision: setupProfile.revision,
      createThread: input.createThread,
      recordInitiator: (taskId) =>
        this.recordSlashInitiator(taskId, input.initiatorMessageId),
    });
  }

  async handleChannelMessage(message: ChannelMessage): Promise<void> {
    const controlChannelId = this.config.DISCORD_CHANNEL_ID;
    if (
      !controlChannelId ||
      message.authorBot ||
      message.channelId !== controlChannelId
    ) {
      return;
    }
    if (await this.store.getByMessageId(message.id)) return;

    const hasAttachments = !!message.attachments?.some((a) => a.url);
    const parsed = parseTaskMessage(message.content, { hasAttachments });
    if (!parsed.ok) {
      await this.replySafely(message, `Rejected: ${parsed.message}`);
      return;
    }

    const instruction = buildInstructionWithAttachments(
      parsed.request.instruction,
      message.attachments,
    ).trim();
    if (!instruction) {
      await this.replySafely(
        message,
        "Rejected: Missing task instruction. Include prose or an attachment.",
      );
      return;
    }

    const request = resolveTaskRequest(
      { ...parsed.request, instruction },
      this.config,
    );
    const policy = validateTaskPolicy(request, this.config);
    if (!policy.ok) {
      await this.replySafely(message, `Rejected: ${policy.reason}`);
      return;
    }
    const setupProfile = await this.setupStore.getReadyProfile(
      request.repo,
      request.branch,
    );
    if (!setupProfile) {
      await this.replySafely(
        message,
        `Rejected: Missing ready setup profile for ${request.repo} on ${request.branch}. Run /setup create with repo ${request.repo} and branch ${request.branch} first.`,
      );
      return;
    }
    const taskRequest: TaskRequest = {
      ...request,
      repo: setupProfile.repo,
      branch: setupProfile.branch,
    };

    const result = await this.admitTask({
      initiatorMessageId: message.id,
      taskRequest,
      setupProfileRevision: setupProfile.revision,
      createThread: (name) => message.createThread(name),
      recordInitiator: (taskId) => this.recordInitiator(taskId, message),
      onAdmitted: () => this.reactSafely(message, EYES),
    });
    if (!result.ok) {
      await this.replySafely(message, result.reason);
    }
  }

  private async admitTask(input: AdmitTaskInput): Promise<StartTaskFromSlashResult> {
    if (await this.store.getByMessageId(input.initiatorMessageId)) {
      return { ok: false, reason: "This task was already submitted." };
    }

    const taskId = randomUUID();
    const { task, created } = await this.store.createDraft({
      id: taskId,
      discordMessageId: input.initiatorMessageId,
      discordThreadId: pendingThreadId(taskId),
      flueInstanceId: pendingThreadId(taskId),
      workspacePath: join(this.config.WORKSPACE_ROOT, taskId),
      setupProfileRevision: input.setupProfileRevision,
      ...input.taskRequest,
    });
    if (!created) {
      return { ok: false, reason: "This task was already submitted." };
    }

    let thread: TaskThreadRef;
    try {
      thread = await input.createThread(threadName(input.taskRequest.repo, taskId));
    } catch (error) {
      const summary = summarizeError(error);
      await this.store.markDraftFailed(task.id, summary);
      return {
        ok: false,
        reason: `Could not create a thread for this task: ${summary}`,
      };
    }

    const headerMessageId = await this.createHeaderMessage(task, thread);

    const instructionPost = formatTaskInstructionForDiscord(
      input.taskRequest.instruction,
    );
    if (instructionPost) {
      try {
        await thread.send(instructionPost);
      } catch (error) {
        console.error(
          "[threadcord] task instruction post failed (task continues)",
          summarizeError(error),
        );
      }
    }

    let statusMessageId: string;
    try {
      statusMessageId = (await thread.send("Queued")).id;
    } catch (error) {
      const summary = summarizeError(error);
      await this.store.markDraftFailed(task.id, summary);
      return {
        ok: false,
        reason: `Task thread created but the status message could not be delivered: ${summary}`,
      };
    }

    const attached = await this.store.attachAndPromote(
      task.id,
      thread.id,
      toFlueInstanceId(thread.id),
      statusMessageId,
      headerMessageId,
    );
    if (!attached) {
      return { ok: false, reason: "Could not attach task to thread." };
    }

    this.taskThreads.set(attached.flueInstanceId, thread);
    input.recordInitiator(attached.id);
    await input.onAdmitted?.();

    // Transactional intake: insert the turn row and send the pg-boss job in
    // one transaction so "row exists but no job" is impossible.
    const { boss, turnStore, pool } = this.requireQueue();
    const initialTurnId = randomUUID();
    await inTransaction(pool, async (client) => {
      await turnStore.insertTurn(
        {
          id: initialTurnId,
          taskId: attached.id,
          source: "initial",
          instruction: input.taskRequest.instruction,
          discordMessageId: input.initiatorMessageId,
        },
        client,
      );
      const jobId = await boss.send(
        TASK_TURN_QUEUE,
        {
          turnId: initialTurnId,
          taskId: attached.id,
          flueInstanceId: attached.flueInstanceId,
          source: "initial",
        },
        { singletonKey: attached.id, db: pgBossDb(client) },
      );
      if (jobId === null) throw new Error("boss.send returned null for initial turn");
    });
    await this.refreshHeader(attached.id);
    return { ok: true, threadId: thread.id, startedImmediately: false };
  }

  async handleThreadMessage(message: TaskThreadMessage): Promise<void> {
    if (message.authorBot) return;
    const task = await this.store.getByThreadId(message.channelId);
    if (!task) return;

    const command = parseThreadControlCommand(message.content);
    if (command === "status") {
      const refreshed = await this.refreshHeader(task.id);
      const headerMessageId = refreshed?.headerMessageId;
      if (!headerMessageId) {
        await message.reply("No pinned header exists for this task yet.");
        return;
      }
      await message.reply(
        `Live status: ${headerJumpLink(message.guildId, task.discordThreadId, headerMessageId)}`,
      );
      return;
    }
    if (command === "abort" || command === "cancel" || command === "done") {
      if (TERMINAL_STATUSES.has(task.status)) {
        await message.reply(`Task is already ${task.status}.`);
        return;
      }
      if (!message.authorId) {
        await message.reply("Cannot verify who sent this command.");
        return;
      }
      await replyThreadView(
        message,
        buildThreadControlConfirmView({
          command,
          userId: message.authorId,
          taskId: task.id,
          prompt: controlPrompt(command),
        }),
      );
      return;
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      await message.reply(
        `Task is ${task.status}. Use /task create to start another task.`,
      );
      return;
    }

    const hasInstruction =
      message.content.trim().length > 0 ||
      !!message.attachments?.some((a) => a.url);
    if (!hasInstruction) {
      await message.reply(
        "Cannot queue an empty instruction. Please include some text or an attachment.",
      );
      return;
    }
    const instructionWithReply = buildInstructionWithReplyQuote(
      message.content,
      message.replyQuote,
    );
    const instructionWithAttachments = buildInstructionWithAttachments(
      instructionWithReply,
      message.attachments,
    ).trim();

    // Record the initiator reaction handle BEFORE the insert so it is in the
    // map when the executor's beginTurn runs.
    this.recordInitiator(task.id, message);

    // Transactional intake: insert turn row + send pg-boss job atomically.
    // Dedupe on discord_message_id via insertTurn's ON CONFLICT; when the
    // insert was skipped (duplicate delivery), skip the send too.
    const { boss, turnStore, pool } = this.requireQueue();
    const followupTurnId = randomUUID();
    const { created } = await inTransaction(pool, async (client) => {
      const result = await turnStore.insertTurn(
        {
          id: followupTurnId,
          taskId: task.id,
          source: "followup",
          instruction: instructionWithAttachments,
          discordMessageId: message.id,
        },
        client,
      );
      if (!result.created) return result;
      const jobId = await boss.send(
        TASK_TURN_QUEUE,
        {
          turnId: followupTurnId,
          taskId: task.id,
          flueInstanceId: task.flueInstanceId,
          source: "followup",
        },
        { singletonKey: task.id, db: pgBossDb(client) },
      );
      if (jobId === null) throw new Error("boss.send returned null for followup turn");
      return result;
    });

    await message.reply(
      created ? "Queued follow-up." : "Follow-up already queued.",
    );
    await this.refreshHeader(task.id);
    void this.reactSafely(message, EYES);
  }

  async handleControlButton(input: HandleControlButtonInput): Promise<void> {
    const parsed = parseThreadControlButtonCustomId(input.customId);
    if (!parsed) {
      await input.reply(errorView("validation", "Invalid task control."));
      return;
    }
    if (input.userId !== parsed.userId) {
      await input.reply(
        errorView(
          "rejection",
          "Only the user who requested this action can confirm it.",
        ),
      );
      return;
    }

    const task = await this.store.getById(parsed.taskId);
    if (!task) {
      await input.reply(errorView("validation", "Task not found."));
      return;
    }

    if (parsed.kind === "dismiss") {
      await input.update(dismissedControlView());
      return;
    }

    await input.defer();
    const outcome = await this.executeThreadControl(task, parsed.command);
    try {
      await input.update(outcome.view);
    } catch (error) {
      console.error("[threadcord] control button outcome update failed", error);
    }
    if (outcome.refreshHeader) {
      await this.refreshHeader(task.id);
    }
  }

  private async executeThreadControl(
    task: TaskRecord,
    command: ThreadControlCommand,
  ): Promise<{ view: ViewPayload; refreshHeader: boolean }> {
    if (command === "abort" || command === "cancel") {
      const queue = this.requireQueue();
      const result = await stopTaskWork(
        task,
        {
          store: this.store,
          turnStore: queue.turnStore,
          boss: queue.boss,
          clearInFlight: (id) => this.clearInFlight(id),
          flipReaction: (initiator, emoji) =>
            this.flipReaction(initiator, emoji),
          disposeInitiators: (taskId, emoji) =>
            this.disposeInitiators(taskId, emoji),
          deleteTaskThread: (id) => {
            this.taskThreads.delete(id);
          },
        },
        { abortInFlight: command === "abort" },
      );
      if (!result.cancelled) {
        return {
          view: controlOutcomeView(
            command,
            false,
            `Task is already ${task.status}.`,
          ),
          refreshHeader: false,
        };
      }
      return { view: controlOutcomeView(command, true), refreshHeader: true };
    }

    const completed = await this.store.transition(
      task.id,
      ["waiting", "queued"],
      "completed",
    );
    if (!completed) {
      return {
        view: controlOutcomeView(
          command,
          false,
          `Cannot mark done from status ${task.status}.`,
        ),
        refreshHeader: false,
      };
    }
    // A completed task must not have queued turns fire later.
    const queue = this.requireQueue();
    await queue.turnStore.cancelPendingTurnsForTask(task.id);
    await releaseTaskSingleton(queue.boss, task.id);
    await this.disposeInitiators(task.id, CHECK);
    this.taskThreads.delete(task.flueInstanceId);
    return { view: controlOutcomeView(command, true), refreshHeader: true };
  }

  /**
   * Resolve the turn outcome for an agent-end event. This is safe to call even
   * when no turn waiter is registered for the instanceId (e.g. setup agents,
   * or late events after an abort already resolved the outcome) because
   * `resolveTurnOutcome` is a no-op when no waiter exists.
   */
  async handleAgentEnd(instanceId: string): Promise<void> {
    resolveTurnOutcome(instanceId, { kind: "completed" });
  }

  async handleAgentFailure(
    instanceId: string,
    errorSummary: string,
  ): Promise<void> {
    resolveTurnOutcome(instanceId, { kind: "failed", errorSummary });
  }

  // -- TurnExecutorHooks implementation -------------------------------------

  /** Set up the in-flight turn entry and dequeue the initiator handle. */
  private beginTurn(task: TaskRecord, initiatorMessageId?: string): void {
    const initiator = initiatorMessageId
      ? this.initiatorMessages.get(initiatorMessageId)
      : undefined;
    if (initiator && initiatorMessageId) {
      this.initiatorMessages.delete(initiatorMessageId);
      this.pendingInitiatorIds.get(task.id)?.delete(initiatorMessageId);
    }
    this.inFlightTurns.set(task.flueInstanceId, { initiator });
  }

  /** Post-turn side effects for a completed turn (moved from handleAgentEnd). */
  private async onTurnCompleted(task: TaskRecord): Promise<void> {
    const userMessages = takePendingUserTurnMessages(task.flueInstanceId);
    await this.refreshHeader(task.id);
    for (const message of userMessages) {
      await this.post(task.discordThreadId, message);
    }
    const turn = this.clearInFlight(task.flueInstanceId);
    await this.flipReaction(turn?.initiator, CHECK);
  }

  /** Side effects for a terminally failed turn (moved from runTurn catch). */
  private async onTurnFailed(
    task: TaskRecord,
    errorSummary: string,
  ): Promise<void> {
    takePendingUserTurnMessages(task.flueInstanceId);
    await this.post(task.discordThreadId, failureDiscordMessage(errorSummary));
    await this.refreshHeader(task.id);
    const turn = this.clearInFlight(task.flueInstanceId);
    await this.flipReaction(turn?.initiator, CROSS);
    await this.disposeInitiators(task.id, CROSS);
    this.taskThreads.delete(task.flueInstanceId);
  }

  /** Start the typing loop and store the timer in the in-flight entry. */
  private startTypingLoopForTask(task: TaskRecord): void {
    const inFlight = this.inFlightTurns.get(task.flueInstanceId);
    if (inFlight) {
      inFlight.typingTimer = this.startTypingLoop(task);
    }
  }

  /** Schedule a readable thread rename (initial turn only). */
  private scheduleRename(threadId: string, instruction: string): void {
    if (this.renameDiscordThread) {
      scheduleReadableThreadRename(threadId, instruction, this.renameDiscordThread);
    }
  }

  private async reactSafely(
    target: ReactionTarget,
    emoji: string,
  ): Promise<void> {
    try {
      await target.react(emoji);
    } catch (error) {
      console.error("[threadcord] reaction failed", error);
    }
  }

  private async replySafely(
    target: { reply(content: string): Promise<void> },
    content: string,
  ): Promise<void> {
    try {
      await target.reply(content);
    } catch (error) {
      console.error("[threadcord] reply failed", error);
    }
  }

  private async flipReaction(
    initiator: ReactionTarget | undefined,
    emoji: string,
  ): Promise<void> {
    if (!initiator) return;
    try {
      await initiator.unreact(EYES);
    } catch (error) {
      console.error("[threadcord] unreact failed", error);
    }
    try {
      await initiator.react(emoji);
    } catch (error) {
      console.error("[threadcord] react failed", error);
    }
  }

  private startTypingLoop(task: TaskRecord): NodeJS.Timeout | undefined {
    const hasThread = this.taskThreads.has(task.flueInstanceId);
    if (!hasThread && !this.sendThreadTyping) return undefined;
    const ping = (): void => {
      const thread = this.taskThreads.get(task.flueInstanceId);
      if (thread) {
        void thread.sendTyping().catch(() => {});
        return;
      }
      void this.sendThreadTyping?.(task.discordThreadId).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, this.typingIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  private clearInFlight(instanceId: string): InFlightTurn | undefined {
    const turn = this.inFlightTurns.get(instanceId);
    if (turn?.typingTimer) clearInterval(turn.typingTimer);
    this.inFlightTurns.delete(instanceId);
    return turn;
  }

  private recordInitiator(
    taskId: string,
    message: ReactionTarget & { id: string },
  ): void {
    this.recordInitiatorById(taskId, message.id);
    this.initiatorMessages.set(message.id, message);
  }

  private recordInitiatorById(taskId: string, messageId: string): void {
    let ids = this.pendingInitiatorIds.get(taskId);
    if (!ids) {
      ids = new Set();
      this.pendingInitiatorIds.set(taskId, ids);
    }
    ids.add(messageId);
  }

  private recordSlashInitiator(taskId: string, messageId: string): void {
    this.recordInitiatorById(taskId, messageId);
    this.initiatorMessages.set(messageId, {
      react: async () => {},
      unreact: async () => {},
    });
  }

  private async disposeInitiators(
    taskId: string,
    finalEmoji: string,
  ): Promise<void> {
    const ids = this.pendingInitiatorIds.get(taskId);
    if (!ids) return;
    for (const id of ids) {
      const handle = this.initiatorMessages.get(id);
      if (handle) await this.flipReaction(handle, finalEmoji);
      this.initiatorMessages.delete(id);
    }
    this.pendingInitiatorIds.delete(taskId);
  }

  private async post(threadId: string, content: string): Promise<void> {
    if (!this.postMessage || isPendingThreadId(threadId)) return;
    try {
      await this.postMessage(threadId, content);
    } catch (error) {
      console.error("[threadcord] thread post failed", error);
    }
  }

  private async createHeaderMessage(
    task: TaskRecord,
    thread: TaskThreadRef,
  ): Promise<string | undefined> {
    const projected: TaskRecord = {
      ...task,
      discordThreadId: thread.id,
      flueInstanceId: toFlueInstanceId(thread.id),
      status: "queued",
    };
    try {
      const payload = renderTaskHeader(projected, { now: new Date() });
      const header = await thread.sendView(payload);
      try {
        await thread.pin(header.id);
      } catch (error) {
        console.error(
          "[threadcord] header pin failed (optional: grant Manage Messages permission to the bot); task continues normally",
          error instanceof Error ? error.message : error,
        );
      }
      return header.id;
    } catch (error) {
      console.error("[threadcord] header send failed", error);
      return undefined;
    }
  }

  private async refreshHeader(
    taskId: string,
    runningTurn?: "initial" | "follow-up",
  ): Promise<TaskRecord | undefined> {
    try {
      const task = await this.store.getById(taskId);
      if (!task?.headerMessageId) return task;
      const queue =
        task.status === "queued"
          ? await this.store.queueSnapshot(task.id)
          : undefined;
      const payload = renderTaskHeader(task, {
        now: new Date(),
        queue,
        runningTurn,
      });
      const taskThread = this.taskThreads.get(task.flueInstanceId);
      if (taskThread && task.headerMessageId) {
        await taskThread.editView(task.headerMessageId, payload);
        return task;
      }
      if (this.editHeaderMessage) {
        await this.editHeaderMessage(
          task.discordThreadId,
          task.headerMessageId,
          payload,
        );
      }
      return task;
    } catch (error) {
      console.error("[threadcord] header refresh failed", error);
      return undefined;
    }
  }
}

function headerJumpLink(
  guildId: string | null | undefined,
  threadId: string,
  messageId: string,
): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${threadId}/${messageId}`;
}

async function replyThreadView(
  message: TaskThreadMessage,
  payload: ViewPayload,
): Promise<void> {
  if (message.replyView) {
    await message.replyView(payload);
    return;
  }
  await message.reply("Confirm or cancel using the buttons above.");
}

/**
 * Describes attachments in the instruction text so the model can fetch and
 * examine them via tools (curl, read, etc.). Images include dimensions;
 * all other files are listed with their type.
 */
/**
 * Prepends the content of an earlier Discord message that this follow-up was a
 * reply to (Discord's reply/reference feature) so the agent sees the context
 * the user was responding to. No-op when the message was not sent as a reply.
 */
function buildInstructionWithReplyQuote(
  instruction: string,
  quote: ThreadMessageReplyQuote | undefined,
): string {
  if (!quote) return instruction;
  const content = quote.content.trim();
  if (!content) return instruction;

  const source = quote.authorBot
    ? "the bot's earlier message"
    : "this earlier message in the thread";
  const quoted = content
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const trimmed = instruction.trim();
  const intro = `The user replied to ${source}:`;
  if (trimmed) {
    return [intro, quoted, "", trimmed].join("\n");
  }
  return [intro, quoted].join("\n");
}

function buildInstructionWithAttachments(
  instruction: string,
  attachments: ThreadMessageAttachment[] | undefined | null,
): string {
  if (!attachments || attachments.length === 0) return instruction;

  const safeName = (name: string): string => name.replace(/]/g, "\\]");

  const descs = attachments
    .filter((a) => a.url)
    .map((a) => {
      const isImage = a.contentType && a.contentType.startsWith("image/");
      const dims =
        a.width && a.height ? ` (${a.width}×${a.height})` : "";
      if (isImage) {
        return `- [Attached image: ${safeName(a.name)}${dims}](${a.url})`;
      }
      const typeLabel = a.contentType ? ` (${a.contentType})` : "";
      return `- [Attached file: ${safeName(a.name)}${typeLabel}](${a.url})`;
    });

  if (descs.length === 0) return instruction;

  const trimmed = instruction.trim();
  const intro = trimmed
    ? "The user attached the following file(s) with this instruction:"
    : "The user attached the following file(s):";

  if (trimmed) {
    return [intro, ...descs, "", trimmed].join("\n");
  }
  return [intro, ...descs].join("\n");
}
