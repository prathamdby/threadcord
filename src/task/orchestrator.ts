import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dispatch } from "@flue/runtime";
import type { AppConfig } from "../config.js";
import { resolveTaskRequest } from "../config.js";
import codingAgent from "../agents/coding.js";
import {
  isPendingThreadId,
  pendingThreadId,
  toFlueInstanceId,
} from "../ids.js";
import { bootstrapWorkspace, runSetupInstall } from "./bootstrap.js";
import { parseTaskMessage } from "./parser.js";
import { validateTaskPolicy } from "./policy.js";
import type { TaskStore } from "./store.js";
import type { SetupEnvironment } from "../setup/profile.js";
import type { SetupStore } from "../setup/store.js";
import { summarizeError } from "../util/redact.js";
import type {
  ChannelMessage,
  ClaimedTurn,
  DispatchAgentInput,
  TaskRecord,
  TaskStatus,
  ThreadMessage,
} from "../types.js";

const TERMINAL_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export class TaskOrchestrator {
  private postMessage?: (threadId: string, content: string) => Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly store: TaskStore,
    private readonly setupStore: SetupStore,
  ) {}

  setMilestonePublisher(
    postMessage: (threadId: string, content: string) => Promise<void>,
  ): void {
    this.postMessage = postMessage;
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
    await this.fillConcurrencySlots();
  }

  async handleChannelMessage(message: ChannelMessage): Promise<void> {
    if (
      message.authorBot ||
      message.channelId !== this.config.DISCORD_CHANNEL_ID
    )
      return;
    if (await this.store.getByMessageId(message.id)) return;

    const parsed = parseTaskMessage(message.content);
    if (!parsed.ok) {
      await message.reply(`Rejected: ${parsed.message}`);
      return;
    }
    const request = resolveTaskRequest(parsed.request, this.config);
    const policy = validateTaskPolicy(request, this.config);
    if (!policy.ok) {
      await message.reply(`Rejected: ${policy.reason}`);
      return;
    }
    const setupProfile = await this.setupStore.getReadyProfile(
      request.repo,
      request.branch,
    );
    if (!setupProfile) {
      await message.reply(
        `Rejected: Missing ready setup profile for ${request.repo} on ${request.branch}. Run /setup create repo:${request.repo} branch:${request.branch} first.`,
      );
      return;
    }
    const taskRequest = {
      ...request,
      repo: setupProfile.repo,
      branch: setupProfile.branch,
    };

    const taskId = randomUUID();
    const { task, created } = await this.store.createTask({
      id: taskId,
      discordMessageId: message.id,
      discordThreadId: pendingThreadId(taskId),
      flueInstanceId: pendingThreadId(taskId),
      workspacePath: join(this.config.WORKSPACE_ROOT, taskId),
      setupProfileRevision: setupProfile.revision,
      ...taskRequest,
    });
    if (!created) return;

    const thread = await message.createThread(threadName(taskRequest.repo, taskId));
    const statusMessage = await thread.send("Queued");
    const attached = await this.store.attachDiscordThread(
      task.id,
      thread.id,
      toFlueInstanceId(thread.id),
      statusMessage.id,
    );

    const claimed = await this.store.claimNextTurn(attached.id);
    if (claimed) {
      await thread.send("Started");
      void this.runTurn(claimed);
    } else {
      const position = await this.store.queuePosition(attached.id);
      await thread.send(`Queued - position ${position}`);
    }
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
      return;
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      await message.reply(
        `Task is ${task.status}. Send a new message in the control channel to start another task.`,
      );
      return;
    }

    const position = await this.store.enqueueFollowup(
      task.id,
      message.id,
      message.content,
    );
    await message.reply(`Queued follow-up - position ${position}`);

    if (task.status === "waiting") {
      const claimed = await this.store.claimNextTurn(task.id);
      if (claimed) void this.runTurn(claimed);
    }
  }

  async handleAgentEnd(instanceId: string): Promise<void> {
    const task = await this.store.getByInstanceId(instanceId);
    if (!task) return;

    if (task.status === "running") {
      await this.store.transition(task.id, "running", "waiting");
      await this.post(
        task.discordThreadId,
        "Turn completed. Waiting for the next instruction.",
      );
      await this.scheduleAfterTurn(task.id);
      return;
    }

    if (task.status === "cancelled" || task.status === "failed") {
      await this.fillConcurrencySlots();
    }
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
    try {
      const checkoutPath = await bootstrapWorkspace(
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
        await runSetupInstall(
          checkoutPath,
          setupProfile.environment.install,
          this.config.GITHUB_TOKEN,
        );
      }
      const input: DispatchAgentInput = {
        kind: "threadcord.turn",
        workspacePath: checkoutPath,
        model: task.model,
        repo: task.repo,
        baseBranch: task.branch,
        instruction: buildPrompt(
          task,
          checkoutPath,
          setupProfile.revision,
          setupProfile.environment,
          setupProfile.memoryMarkdown,
          instruction,
        ),
      };
      await dispatch(codingAgent, {
        id: task.flueInstanceId,
        input,
      });
      await this.post(task.discordThreadId, "Agent turn accepted.");
    } catch (error) {
      const summary = summarizeError(error);
      await this.store.transition(
        task.id,
        ["queued", "waiting", "running"],
        "failed",
        summary,
      );
      await this.post(task.discordThreadId, `Failed: ${summary}`);
      await this.fillConcurrencySlots();
    }
  }

  private async post(threadId: string, content: string): Promise<void> {
    if (!this.postMessage || isPendingThreadId(threadId)) return;
    await this.postMessage(threadId, content);
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
    ...(task.pushOverride
      ? [`Push override: ${task.pushOverride}`]
      : []),
    `Workspace: ${checkoutPath}`,
    `Model: ${task.model}`,
    `Admitted setup profile revision: ${task.setupProfileRevision}`,
    `Active setup profile revision: ${activeSetupProfileRevision}`,
    `Setup install command: ${setupEnvironment.install}`,
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

function threadName(repo: string, taskId: string): string {
  return `threadcord-${repo.replace("/", "-")}-${taskId.slice(0, 8)}`.slice(
    0,
    90,
  );
}

function formatChecks(checks: Record<string, string>): string {
  const entries = Object.entries(checks);
  if (entries.length === 0) return "none";
  return entries.map(([name, command]) => `${name}=${command}`).join("; ");
}
