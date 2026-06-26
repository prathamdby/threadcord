import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dispatch } from "@flue/runtime";
import { failureDiscordMessage } from "../discord/observe-bridge.js";
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
import { validateTaskPolicy } from "./policy.js";
import type { TaskStore } from "./store.js";
import type { SetupEnvironment } from "../setup/profile.js";
import type { SetupStore } from "../setup/store.js";
import { summarizeError } from "../util/redact.js";
import {
  scheduleReadableThreadRename,
  type RenameDiscordThread,
} from "./rename-thread.js";
import { threadName } from "./thread-name.js";
import type {
  ClaimedTurn,
  DispatchAgentInput,
  TaskRecord,
  TaskRequest,
  TaskStatus,
  ThreadMessage,
  ThreadRef,
} from "../types.js";

export type StartTaskFromSlashResult =
  | { ok: false; reason: string }
  | { ok: true; threadId: string; startedImmediately: boolean };

export interface StartTaskFromSlashInput {
  initiatorMessageId: string;
  pending: PendingTaskCreate;
  createThread: (name: string) => Promise<ThreadRef>;
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
  private renameDiscordThread?: RenameDiscordThread;
  private readonly taskThreads = new Map<string, ThreadRef>();
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

  setThreadRenamer(renameDiscordThread: RenameDiscordThread): void {
    this.renameDiscordThread = renameDiscordThread;
  }

  async resumeAfterRestart(
    notifyThread: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    const released = await this.store.releaseRunningAfterRestart();
    for (const task of released) {
      if (!isPendingThreadId(task.discordThreadId)) {
        await notifyThread(
          task.discordThreadId,
          "Resumed after restart. Ready for the next instruction.",
        );
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
      setupProfileRevision: setupProfile.revision,
      ...taskRequest,
    });
    if (!created) {
      return { ok: false, reason: "This task was already submitted." };
    }

    let thread: ThreadRef;
    try {
      thread = await input.createThread(threadName(taskRequest.repo, taskId));
    } catch (error) {
      const summary = summarizeError(error);
      await this.store.markDraftFailed(task.id, summary);
      return {
        ok: false,
        reason: `Could not create a thread for this task: ${summary}`,
      };
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
    );
    if (!attached) {
      return { ok: false, reason: "Could not attach task to thread." };
    }

    this.taskThreads.set(attached.flueInstanceId, thread);
    this.recordSlashInitiator(attached.id, input.initiatorMessageId);

    const claimed = await this.store.claimNextTurn(attached.id);
    if (claimed) {
      await thread.send("Started");
      void this.runTurn(claimed);
      return { ok: true, threadId: thread.id, startedImmediately: true };
    }
    const position = await this.store.queuePosition(attached.id);
    await thread.send(`Queued - position ${position}`);
    return { ok: true, threadId: thread.id, startedImmediately: false };
  }

  async handleThreadMessage(message: ThreadMessage): Promise<void> {
    if (message.authorBot) return;
    const task = await this.store.getByThreadId(message.channelId);
    if (!task) return;

    const command = message.content.trim().toLowerCase();
    if (command === "status") {
      await message.reply(`Status: ${task.status}`);
      return;
    }
    if (command === "cancel") {
      const cancelled = await this.store.cancelTask(task.id);
      if (!cancelled) {
        await message.reply(`Task is already ${task.status}.`);
        return;
      }
      await message.reply(
        "Cancelled. No further turns will be dispatched for this task.",
      );
      // The current turn's initiator, if any, was moved from pending to
      // in-flight by runTurn, so clearInFlight flips it and disposeInitiators
      // (which only touches pending) cannot double-handle the same message.
      clearPendingUserTurnMessage(task.flueInstanceId);
      const turn = this.clearInFlight(task.flueInstanceId);
      await this.flipReaction(turn?.initiator, CROSS);
      await this.disposeInitiators(task.id, CROSS);
      this.taskThreads.delete(task.flueInstanceId);
      await this.fillConcurrencySlots();
      return;
    }
    if (command === "done") {
      const completed = await this.store.transition(
        task.id,
        ["waiting", "queued"],
        "completed",
      );
      if (!completed) {
        await message.reply(`Cannot mark done from status ${task.status}.`);
        return;
      }
      await message.reply("Task marked complete.");
      await this.disposeInitiators(task.id, CHECK);
      this.taskThreads.delete(task.flueInstanceId);
      return;
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      await message.reply(
        `Task is ${task.status}. Use /task create to start another task.`,
      );
      return;
    }

    const position = await this.store.enqueueFollowup(
      task.id,
      message.id,
      message.content,
    );
    await message.reply(`Queued follow-up - position ${position}`);
    this.recordInitiator(task.id, message);
    void this.reactSafely(message, EYES);

    if (task.status === "waiting") {
      const claimed = await this.store.claimNextTurn(task.id);
      if (claimed) void this.runTurn(claimed);
    }
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
      if (userMessages.length === 0) {
        await this.post(
          task.discordThreadId,
          "Turn completed. Waiting for the next instruction.",
        );
      } else {
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

    await this.post(
      task.discordThreadId,
      failureDiscordMessage(failed.errorSummary ?? errorSummary),
    );
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
      const thread = this.taskThreads.get(task.flueInstanceId);
      const inFlight = this.inFlightTurns.get(task.flueInstanceId);
      if (thread && inFlight) {
        inFlight.typingTimer = this.startTypingLoop(thread);
      }
      await this.post(task.discordThreadId, "Agent turn accepted.");
    } catch (error) {
      const summary = summarizeError(error);
      takePendingUserTurnMessages(task.flueInstanceId);
      await this.store.transition(
        task.id,
        ["queued", "waiting", "running"],
        "failed",
        summary,
      );
      await this.post(task.discordThreadId, `Failed: ${summary}`);
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

  private startTypingLoop(thread: ThreadRef): NodeJS.Timeout {
    const ping = (): void => {
      void thread.sendTyping().catch(() => {});
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
