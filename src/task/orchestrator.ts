import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dispatch } from "@flue/runtime";
import { failureDiscordMessage } from "../discord/observe-bridge.js";
import { formatTaskInstructionForDiscord } from "../discord/task-instruction-message.js";
import { renderTaskHeader } from "../discord/task-header.js";
import type { ViewPayload } from "../discord/ui/index.js";
import { errorView } from "../discord/ui/index.js";
import {
  clearPendingUserTurnMessage,
  takePendingUserTurnMessages,
} from "../discord/user-turn-message.js";
import type { AppConfig } from "../config.js";
import { resolveTaskRequest } from "../config.js";
import codingAgent from "../agents/coding.js";
import {
  isPendingThreadId,
  pendingThreadId,
  toFlueInstanceId,
} from "../ids.js";
import {
  bootstrapWorkspace,
  runSetupInstall,
  runSetupSkillsInstall,
} from "./bootstrap.js";
import type { BootstrapMode } from "./bootstrap.js";
import type { PendingTaskCreate } from "./create-flow.js";
import { parseTaskMessage } from "./parser.js";
import { validateTaskPolicy } from "./policy.js";
import type { TaskStore } from "./store.js";
import type { SetupEnvironment } from "../setup/profile.js";
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
  ClaimedTurn,
  DispatchAgentInput,
  TaskRecord,
  TaskRequest,
  TaskStatus,
  ThreadMessage,
  ThreadMessageAttachment,
  ThreadMessageReplyQuote,
} from "../types.js";

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
  ) {}

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
    const released = await this.store.releaseRunningAfterRestart();
    for (const task of released) {
      await this.refreshHeader(task.id);
      if (!isPendingThreadId(task.discordThreadId)) {
        try {
          await notifyThread(
            task.discordThreadId,
            "Resumed after restart. Ready for the next instruction.",
          );
        } catch (error) {
          console.error(
            `[threadcord] restart notification failed for task ${task.id} (thread ${task.discordThreadId}):`,
            summarizeError(error),
          );
        }
      }
    }
    await this.store.failAbandonedDrafts();
    await this.fillConcurrencySlots();
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

    const claimed = await this.store.claimNextTurn(attached.id);
    if (claimed) {
      void this.runTurn(claimed);
      return { ok: true, threadId: thread.id, startedImmediately: true };
    }
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
    const position = await this.store.enqueueFollowup(
      task.id,
      message.id,
      instructionWithAttachments,
    );
    await message.reply(`Queued follow-up - position ${position}`);
    await this.refreshHeader(task.id);
    this.recordInitiator(task.id, message);
    void this.reactSafely(message, EYES);

    if (task.status === "waiting") {
      const claimed = await this.store.claimNextTurn(task.id);
      if (claimed) void this.runTurn(claimed);
    }
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
      const result = await stopTaskWork(
        task,
        {
          store: this.store,
          clearInFlight: (id) => this.clearInFlight(id),
          flipReaction: (initiator, emoji) =>
            this.flipReaction(initiator, emoji),
          disposeInitiators: (taskId, emoji) =>
            this.disposeInitiators(taskId, emoji),
          deleteTaskThread: (id) => {
            this.taskThreads.delete(id);
          },
          fillConcurrencySlots: () => this.fillConcurrencySlots(),
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
    await this.disposeInitiators(task.id, CHECK);
    this.taskThreads.delete(task.flueInstanceId);
    return { view: controlOutcomeView(command, true), refreshHeader: true };
  }

  async handleAgentEnd(instanceId: string): Promise<void> {
    const task = await this.store.getByInstanceId(instanceId);
    if (!task) return;

    if (task.status === "running") {
      const turned = await this.store.transition(task.id, "running", "waiting");
      if (!turned) {
        // A concurrent cancel/failure changed the status between the read
        // and this transition; its own handler did the cleanup and slot fill.
        clearPendingUserTurnMessage(instanceId);
        this.clearInFlight(instanceId);
        await this.fillConcurrencySlots();
        return;
      }
      const userMessages = takePendingUserTurnMessages(instanceId);
      await this.refreshHeader(task.id);
      if (userMessages.length > 0) {
        for (const message of userMessages) {
          await this.post(task.discordThreadId, message);
        }
      }
      const turn = this.clearInFlight(instanceId);
      await this.flipReaction(turn?.initiator, CHECK);
      await this.scheduleAfterTurn(task.id);
      return;
    }

    clearPendingUserTurnMessage(instanceId);
    this.clearInFlight(instanceId);
    if (task.status === "cancelled" || task.status === "failed") {
      await this.fillConcurrencySlots();
    }
  }

  async handleAgentFailure(
    instanceId: string,
    errorSummary: string,
  ): Promise<void> {
    const task = await this.store.getByInstanceId(instanceId);
    if (!task) return;

    const failed = await this.store.transition(
      task.id,
      "running",
      "failed",
      summarizeError(new Error(errorSummary)),
    );
    if (!failed) return;

    takePendingUserTurnMessages(instanceId);

    console.error(
      `[threadcord] task ${task.id} agent failure details:`,
      summarizeError(errorSummary),
    );
    await this.post(
      task.discordThreadId,
      failureDiscordMessage(failed.errorSummary ?? errorSummary),
    );
    await this.refreshHeader(task.id);
    const turn = this.clearInFlight(instanceId);
    await this.flipReaction(turn?.initiator, CROSS);
    await this.disposeInitiators(task.id, CROSS);
    this.taskThreads.delete(instanceId);
    await this.fillConcurrencySlots();
  }

  private async scheduleAfterTurn(taskId: string): Promise<void> {
    const claimed = await this.store.claimNextTurn(taskId);
    if (claimed) {
      void this.runTurn(claimed);
      return;
    }
    await this.fillConcurrencySlots();
  }

  private async fillConcurrencySlots(): Promise<void> {
    for (;;) {
      const claimed = await this.store.claimNextTurn();
      if (!claimed) break;
      void this.runTurn(claimed);
    }
  }

  private async runTurn(claimed: ClaimedTurn): Promise<void> {
    const { task, instruction, source } = claimed;
    const initiator = this.initiatorMessages.get(claimed.initiatorMessageId);
    if (initiator) {
      this.initiatorMessages.delete(claimed.initiatorMessageId);
      this.pendingInitiatorIds.get(task.id)?.delete(claimed.initiatorMessageId);
    }
    this.inFlightTurns.set(task.flueInstanceId, { initiator });
    await this.refreshHeader(
      task.id,
      source === "initial" ? "initial" : "follow-up",
    );
    try {
      const checkoutPath = await this.bootstrap(
        task,
        this.config.GITHUB_TOKEN,
        source === "initial" ? "initial" : "continue",
      );
      const setupProfile = await this.setupStore.getReadyProfile(
        task.repo,
        task.branch,
      );
      if (!setupProfile) {
        throw new Error(
          `Missing ready setup profile for ${task.repo} on ${task.branch}`,
        );
      }
      if (source === "initial") {
        await this.runSetupInstallTurn(
          task.workspacePath,
          checkoutPath,
          setupProfile.environment.install,
          this.config.GITHUB_TOKEN,
        );
        const skillLinks = setupProfile.environment.skills ?? [];
        if (skillLinks.length > 0) {
          await runSetupSkillsInstall(
            task.workspacePath,
            checkoutPath,
            skillLinks,
            this.config.GITHUB_TOKEN,
          );
        }
      }
      // A concurrent cancel transitions the task out of running during setup;
      // re-check the store (source of truth) before dispatching, since the
      // in-flight entry may have been re-created here after cancel cleared it.
      const current = await this.store.getByInstanceId(task.flueInstanceId);
      if (!current || current.status !== "running") {
        this.clearInFlight(task.flueInstanceId);
        return;
      }
      const fullPrompt = buildPrompt(
        task,
        checkoutPath,
        setupProfile.revision,
        setupProfile.environment,
        setupProfile.memoryMarkdown,
        instruction,
      );
      const input: DispatchAgentInput = {
        kind: "threadcord.turn",
        workspacePath: checkoutPath,
        model: task.model,
        repo: task.repo,
        baseBranch: task.branch,
        instruction: fullPrompt,
      };
      if (source === "initial" && this.renameDiscordThread) {
        scheduleReadableThreadRename(
          task.discordThreadId,
          instruction,
          this.renameDiscordThread,
        );
      }
      await this.dispatchTurn(task.flueInstanceId, input);
      const inFlight = this.inFlightTurns.get(task.flueInstanceId);
      if (inFlight) {
        inFlight.typingTimer = this.startTypingLoop(task);
      }
      await this.post(task.discordThreadId, "Agent turn accepted.");
    } catch (error) {
      const summary = summarizeError(error);
      takePendingUserTurnMessages(task.flueInstanceId);
      console.error(
        `[threadcord] task ${task.id} turn failure details:`,
        summary,
      );
      await this.store.transition(
        task.id,
        ["queued", "waiting", "running"],
        "failed",
        summary,
      );
      await this.refreshHeader(task.id);
      await this.post(task.discordThreadId, failureDiscordMessage(summary));
      const turn = this.clearInFlight(task.flueInstanceId);
      await this.flipReaction(turn?.initiator, CROSS);
      await this.disposeInitiators(task.id, CROSS);
      this.taskThreads.delete(task.flueInstanceId);
      await this.fillConcurrencySlots();
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

function buildPrompt(
  task: TaskRecord,
  checkoutPath: string,
  activeSetupProfileRevision: number,
  setupEnvironment: SetupEnvironment,
  setupMemoryMarkdown: string,
  instruction: string,
): string {
  const lines = [
    `Task id: ${task.id}`,
    `Repository: ${task.repo}`,
    `Base branch: ${task.branch}`,
    ...(task.pushOverride ? [`Push override: ${task.pushOverride}`] : []),
    `Workspace: ${checkoutPath}`,
    `Model: ${task.model}`,
    `Admitted setup profile revision: ${task.setupProfileRevision}`,
    `Active setup profile revision: ${activeSetupProfileRevision}`,
    `Setup install command: ${setupEnvironment.install}`,
    `Setup skills: ${
      setupEnvironment.skills?.length
        ? setupEnvironment.skills.join("; ")
        : "none"
    }`,
    `Setup checks: ${formatChecks(setupEnvironment.checks)}`,
    `Required env: ${setupEnvironment.requiredEnv.join(", ") || "none"}`,
    `Required services: ${setupEnvironment.requiredServices.join(", ") || "none"}`,
    "",
    "Setup profile memory:",
    setupMemoryMarkdown,
    "",
    instruction,
  ];
  return lines.join("\n");
}

function formatChecks(checks: Record<string, string>): string {
  const entries = Object.entries(checks);
  if (entries.length === 0) return "none";
  return entries.map(([name, command]) => `${name}=${command}`).join("; ");
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
