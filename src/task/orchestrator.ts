import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { failureDiscordMessage } from "../discord/observe-bridge.js";
import { formatTaskInstructionForDiscord } from "../discord/task-instruction-message.js";
import { renderTaskHeader } from "../discord/task-header.js";
import {
  clearPendingUserTurnMessage,
  takePendingUserTurnMessages,
} from "../discord/user-turn-message.js";
import type { AppConfig } from "../config.js";
import { resolveTaskRequest } from "../config.js";
import {
  createDefaultMachineEnvironment,
  type AgentTurn,
  type AgentTurnInput,
  type MachineEnvironment,
  type TurnEvent,
} from "../agentturn/index.js";
import type { Logger as RenameLogger } from "../agentturn/host-thread-namer.js";
import {
  createNoopMcpRegistry,
  type McpRegistry,
  McpRegistryConfigProvider,
} from "../mcp/registry.js";
import {
  isPendingThreadId,
  pendingThreadId,
  toAgentInstanceId,
} from "../ids.js";
import { discoverInstalledSkills } from "../setup/skills.js";
import { workspacePaths } from "./workspace-env.js";
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
import {
  parseThreadControlCommand,
  stopTaskWork,
} from "./abort-thread-task.js";
import { threadName } from "./thread-name.js";
import type {
  ClaimedTurn,
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
  source: "initial" | "followup";
  initiator?: ReactionTarget | undefined;
  typingTimer?: NodeJS.Timeout | undefined;
}

export type EditHeaderMessage = (
  threadId: string,
  messageId: string,
  content: string,
) => Promise<void>;

export type SendThreadTyping = (threadId: string) => Promise<void>;

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
  private threadRenameLogger?: RenameLogger;
  private readonly taskThreads = new Map<string, ThreadRef>();
  private readonly initiatorMessages = new Map<string, ReactionTarget>();
  private readonly pendingInitiatorIds = new Map<string, Set<string>>();
  private readonly inFlightTurns = new Map<string, InFlightTurn>();
  private readonly unsubscribeAgentTurn: () => void;
  private readonly machineEnvironment: MachineEnvironment;
  private readonly mcpRegistry: McpRegistry;
  private readonly mcpConfigProvider: McpRegistryConfigProvider;

  constructor(
    private readonly config: AppConfig,
    private readonly store: TaskStore,
    private readonly setupStore: SetupStore,
    private readonly agentTurn: AgentTurn,
    machineEnvironment?: MachineEnvironment,
    mcpRegistry?: McpRegistry,
    private readonly typingIntervalMs: number = TYPING_INTERVAL_MS,
  ) {
    this.mcpRegistry = mcpRegistry ?? createNoopMcpRegistry();
    this.mcpConfigProvider = new McpRegistryConfigProvider(this.mcpRegistry);
    this.machineEnvironment =
      machineEnvironment ??
      createDefaultMachineEnvironment(config, this.mcpConfigProvider);
    this.unsubscribeAgentTurn = this.agentTurn.onEvent((event) =>
      this.handleAgentTurnEvent(event),
    );
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

  setThreadRenameLogger(logger: RenameLogger): void {
    this.threadRenameLogger = logger;
  }

  async resumeAfterRestart(
    notifyThread: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    await this.agentTurn.resumeAfterRestart(notifyThread);
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

    if (await this.store.getByMessageId(input.initiatorMessageId)) {
      return { ok: false, reason: "This task was already submitted." };
    }

    const taskId = randomUUID();
    const { task, created } = await this.store.createDraft({
      id: taskId,
      discordMessageId: input.initiatorMessageId,
      discordThreadId: pendingThreadId(taskId),
      agentInstanceId: pendingThreadId(taskId),
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

    const headerMessageId = await this.createHeaderMessage(task, thread);

    const instructionPost = formatTaskInstructionForDiscord(
      taskRequest.instruction,
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
      toAgentInstanceId(thread.id),
      statusMessageId,
      headerMessageId,
    );
    if (!attached) {
      return { ok: false, reason: "Could not attach task to thread." };
    }

    this.taskThreads.set(attached.agentInstanceId, thread);
    this.recordSlashInitiator(attached.id, input.initiatorMessageId);

    const claimed = await this.store.claimNextTurn(attached.id);
    if (claimed) {
      void this.runTurn(claimed);
      return { ok: true, threadId: thread.id, startedImmediately: true };
    }
    await this.refreshHeader(attached.id);
    return { ok: true, threadId: thread.id, startedImmediately: false };
  }

  async handleThreadMessage(message: ThreadMessage): Promise<void> {
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
    if (command === "abort" || command === "cancel") {
      const result = await stopTaskWork(
        task,
        {
          store: this.store,
          agentTurn: this.agentTurn,
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
        await message.reply(`Task is already ${task.status}.`);
        return;
      }
      const reply =
        command === "abort"
          ? "Aborted. The in-flight agent turn was stopped and no further turns will run."
          : "Cancelled. No further turns will be dispatched for this task.";
      await message.reply(reply);
      await this.refreshHeader(task.id);
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
      await this.refreshHeader(task.id);
      await this.disposeInitiators(task.id, CHECK);
      this.taskThreads.delete(task.agentInstanceId);
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
    await this.refreshHeader(task.id);
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
      await this.refreshHeader(task.id);
      if (userMessages.length > 0) {
        for (const message of userMessages) {
          await this.post(task.discordThreadId, message);
        }
      }
      const turn = this.clearInFlight(instanceId);
      await this.flipReaction(turn?.initiator, CHECK);
      if (this.renameDiscordThread && turn?.source === "initial") {
        scheduleReadableThreadRename(
          task.discordThreadId,
          task.instruction,
          this.config.defaultModel,
          this.renameDiscordThread,
          this.threadRenameLogger,
        );
      }
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

  private async handleAgentTurnEvent(event: TurnEvent): Promise<void> {
    if (event.type !== "terminal") return;
    if (event.outcome === "failed" || event.outcome === "aborted") {
      await this.handleAgentFailure(
        event.instanceId,
        event.summary ?? "Agent turn failed",
      );
      return;
    }
    await this.handleAgentEnd(event.instanceId);
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
    const instanceId = task.agentInstanceId;
    const initiator = this.initiatorMessages.get(claimed.initiatorMessageId);
    if (initiator) {
      this.initiatorMessages.delete(claimed.initiatorMessageId);
      this.pendingInitiatorIds.get(task.id)?.delete(claimed.initiatorMessageId);
    }
    this.inFlightTurns.set(instanceId, { source, initiator });
    await this.refreshHeader(
      task.id,
      source === "initial" ? "initial" : "follow-up",
    );
    try {
      const setupProfile = await this.setupStore.getReadyProfile(
        task.repo,
        task.branch,
      );
      if (!setupProfile) {
        throw new Error(
          `Missing ready setup profile for ${task.repo} on ${task.branch}`,
        );
      }

      this.mcpConfigProvider.setWorkspacePath(task.workspacePath);

      const prepareResult = await this.machineEnvironment.prepare({
        instanceId,
        role: "coding",
        task,
        source,
        setupProfile,
        model: task.model,
      });

      if (!prepareResult.ready) {
        if (prepareResult.issue) {
          await this.machineEnvironment.reportIssue(prepareResult.issue);
        }
        await this.post(
          task.discordThreadId,
          `Environment issue: ${prepareResult.reason}`,
        );
        this.store.releaseReservation(task.id);
        this.clearInFlight(instanceId);
        return;
      }

      // A concurrent cancel may have changed the task status while we were
      // preparing the environment. Re-check the store (source of truth) before
      // asking AgentTurn to admit the turn.
      const current = await this.store.getByInstanceId(instanceId);
      if (!current || (current.status !== "queued" && current.status !== "waiting")) {
        this.store.releaseReservation(task.id);
        this.clearInFlight(instanceId);
        return;
      }
      const fullPrompt = buildPrompt(
        task,
        prepareResult.checkoutPath,
        setupProfile.revision,
        setupProfile.environment,
        setupProfile.memoryMarkdown,
        instruction,
        prepareResult.workspacePath,
      );
      const input: AgentTurnInput = {
        instanceId,
        role: "coding",
        instruction: fullPrompt,
        model: task.model,
        workspacePath: prepareResult.workspacePath,
        repo: task.repo,
        baseBranch: task.branch,
        setupProfileRevision: task.setupProfileRevision,
        idempotencyKey:
          source === "initial"
            ? task.discordMessageId
            : claimed.initiatorMessageId,
      };
      const promptResult = await this.agentTurn.prompt(input);
      if (!promptResult.accepted) {
        await this.post(
          task.discordThreadId,
          `Turn not started: ${promptResult.reason}`,
        );
        this.store.releaseReservation(task.id);
        this.clearInFlight(instanceId);
        return;
      }

      const committed = await this.store.commitTurn(claimed);
      if (!committed) {
        await this.agentTurn.cancel(instanceId);
        this.store.releaseReservation(task.id);
        this.clearInFlight(instanceId);
        await this.fillConcurrencySlots();
        return;
      }

      const inFlight = this.inFlightTurns.get(instanceId);
      if (inFlight) {
        inFlight.typingTimer = this.startTypingLoop(committed);
      }
      await this.refreshHeader(
        task.id,
        source === "initial" ? "initial" : "follow-up",
      );
      await this.post(task.discordThreadId, "Agent turn accepted.");
    } catch (error) {
      const summary = summarizeError(error);
      takePendingUserTurnMessages(instanceId);
      console.error(
        `[threadcord] task ${task.id} turn failure details:`,
        summary,
      );
      // Release any reserved claim before failing the task. All pre-commit
      // exception paths (missing setup profile, prepare throws, prompt throws,
      // etc.) land here and must not leak concurrency capacity.
      this.store.releaseReservation(task.id);
      await this.store.transition(
        task.id,
        ["queued", "waiting", "running"],
        "failed",
        summary,
      );
      await this.refreshHeader(task.id);
      await this.post(task.discordThreadId, failureDiscordMessage(summary));
      const turn = this.clearInFlight(instanceId);
      await this.flipReaction(turn?.initiator, CROSS);
      await this.disposeInitiators(task.id, CROSS);
      this.taskThreads.delete(instanceId);
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

  private startTypingLoop(task: TaskRecord): NodeJS.Timeout | undefined {
    const hasThread = this.taskThreads.has(task.agentInstanceId);
    if (!hasThread && !this.sendThreadTyping) return undefined;
    const ping = (): void => {
      const thread = this.taskThreads.get(task.agentInstanceId);
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
    thread: ThreadRef,
  ): Promise<string | undefined> {
    const projected: TaskRecord = {
      ...task,
      discordThreadId: thread.id,
      agentInstanceId: toAgentInstanceId(thread.id),
      status: "queued",
    };
    try {
      const header = await thread.send(
        renderTaskHeader(projected, { now: new Date() }),
      );
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
      const content = renderTaskHeader(task, {
        now: new Date(),
        queue,
        runningTurn,
      });
      const thread = this.taskThreads.get(task.agentInstanceId);
      if (this.editHeaderMessage) {
        await this.editHeaderMessage(
          task.discordThreadId,
          task.headerMessageId,
          content,
        );
        return task;
      }
      if (thread) {
        await thread.editMessage(task.headerMessageId, content);
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

function buildPrompt(
  task: TaskRecord,
  checkoutPath: string,
  activeSetupProfileRevision: number,
  setupEnvironment: SetupEnvironment,
  setupMemoryMarkdown: string,
  instruction: string,
  workspaceRoot?: string,
): string {
  const installedSkills = workspaceRoot
    ? discoverInstalledSkills(workspacePaths(workspaceRoot).home)
    : [];
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
    ...(installedSkills.length > 0
      ? [
          "",
          "Installed skills (available via `~/.agents/skills/<name>/SKILL.md`):",
          ...installedSkills.map((name) => `- ${name}`),
          "",
          "When the user instruction references a skill by name (e.g. '/prath-mode', 'use commit', 'call peer-review'), read the corresponding SKILL.md and follow its workflow. Skills are already installed globally; do not reinstall them.",
        ]
      : []),
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
