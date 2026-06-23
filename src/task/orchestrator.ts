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
import { bootstrapWorkspace } from "./bootstrap.js";
import { parseTaskMessage } from "./parser.js";
import { targetBranchForTask, validateTaskPolicy } from "./policy.js";
import type { TaskStorePort } from "./store.js";
import { summarizeError } from "../util/redact.js";
import type {
  ChannelMessage,
  ClaimedTurn,
  DispatchAgentInput,
  TaskRecord,
  ThreadMessage,
} from "../types.js";

/** Sends one dispatched agent turn. Injectable so tests can fake the runtime. */
export type DispatchTurn = (
  instanceId: string,
  input: DispatchAgentInput,
) => Promise<void>;

/** Prepares a turn's workspace checkout. Injectable so tests can skip git. */
export type BootstrapTurn = (
  task: TaskRecord,
  githubToken: string,
  mode: "initial" | "continue",
) => Promise<string>;

const defaultDispatchTurn: DispatchTurn = async (instanceId, input) => {
  await dispatch(codingAgent, { id: instanceId, input });
};

export class TaskOrchestrator {
  private postMessage?: (threadId: string, content: string) => Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly store: TaskStorePort,
    private readonly dispatchTurn: DispatchTurn = defaultDispatchTurn,
    private readonly bootstrap: BootstrapTurn = bootstrapWorkspace,
  ) {}

  setMilestonePublisher(
    postMessage: (threadId: string, content: string) => Promise<void>,
  ): void {
    this.postMessage = postMessage;
  }

  async resumeAfterRestart(): Promise<void> {
    const { resumed, cancelled } = await this.store.reconcileAfterRestart();
    for (const task of resumed) {
      await this.post(
        task.discordThreadId,
        "Resumed after restart. Ready for the next instruction.",
      );
    }
    for (const task of cancelled) {
      await this.post(
        task.discordThreadId,
        "Cancellation complete after restart. The task has stopped.",
      );
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
    const admittedRequest = policy.request;

    const taskId = randomUUID();
    const { task, created } = await this.store.createTask({
      id: taskId,
      discordMessageId: message.id,
      discordThreadId: pendingThreadId(taskId),
      flueInstanceId: pendingThreadId(taskId),
      workspacePath: join(this.config.WORKSPACE_ROOT, taskId),
      ...admittedRequest,
    });
    if (!created) return;

    const thread = await message.createThread(
      threadName(admittedRequest.repo, taskId),
    );
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
      const outcome = await this.store.requestCancel(task.id);
      if (outcome.kind === "terminal") {
        await message.reply(
          "Cancelled. No further turns will be dispatched for this task.",
        );
        await this.fillConcurrencySlots();
        return;
      }
      if (outcome.kind === "requested") {
        // Fail closed. The Flue runtime exposes no safe way to interrupt a
        // dispatched durable turn, so the slot stays held until agent end
        // rather than claiming the limit is free while the turn runs on. A
        // future runtime interruption call would go here, before this reply.
        await message.reply(
          "Cancellation requested. No new turns or follow-ups will be scheduled. The current turn is still winding down. A final message will post when it stops.",
        );
        return;
      }
      await message.reply(`Task is already ${outcome.task.status}.`);
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

    // The store decides follow-up eligibility under a row lock, so a concurrent
    // cancel cannot leave an orphaned follow-up that never runs.
    const enqueued = await this.store.enqueueFollowup(
      task.id,
      message.id,
      message.content,
    );
    if (!enqueued.ok) {
      if (enqueued.status === "cancelling") {
        await message.reply(
          "Cancellation is in progress. No further turns will be scheduled for this task.",
        );
        return;
      }
      await message.reply(
        `Task is ${enqueued.status}. Send a new message in the control channel to start another task.`,
      );
      return;
    }
    await message.reply(`Queued follow-up - position ${enqueued.position}`);

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

    if (task.status === "cancelling") {
      // The active turn has ended, so cancellation is now real. Finalize the
      // terminal state and only then free the slot it was holding.
      await this.store.transition(task.id, "cancelling", "cancelled");
      await this.post(
        task.discordThreadId,
        "Cancellation complete. The task has stopped. Start a new task in the control channel to continue.",
      );
      await this.fillConcurrencySlots();
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
      const checkoutPath = await this.bootstrap(
        task,
        this.config.GITHUB_TOKEN,
        source === "initial" ? "initial" : "continue",
      );
      const featureBranch = targetBranchForTask(task.id, task);
      const input: DispatchAgentInput = {
        kind: "threadcord.turn",
        workspacePath: checkoutPath,
        model: task.model,
        repo: task.repo,
        baseBranch: task.branch,
        featureBranch,
        instruction: buildPrompt(
          task,
          checkoutPath,
          featureBranch,
          instruction,
        ),
      };
      await this.dispatchTurn(task.flueInstanceId, input);
      await this.post(task.discordThreadId, "Agent turn accepted.");
    } catch (error) {
      const summary = summarizeError(error);
      const failed = await this.store.transition(
        task.id,
        ["queued", "waiting", "running"],
        "failed",
        summary,
      );
      if (failed) {
        await this.post(task.discordThreadId, `Failed: ${summary}`);
      } else {
        // The turn was already cancellation-requested when dispatch failed.
        // Finalize cancellation rather than reporting a failure that the user
        // did not cause.
        const cancelled = await this.store.transition(
          task.id,
          "cancelling",
          "cancelled",
        );
        if (cancelled) {
          await this.post(
            task.discordThreadId,
            "Cancellation complete. The task has stopped.",
          );
        }
      }
      await this.fillConcurrencySlots();
    }
  }

  private async post(threadId: string, content: string): Promise<void> {
    if (!this.postMessage || isPendingThreadId(threadId)) return;
    // Discord is a best-effort boundary. A failed notification (archived or
    // deleted thread, transient API error) must never abort scheduling or
    // state transitions that follow the post.
    try {
      await this.postMessage(threadId, content);
    } catch (error) {
      console.error("[threadcord] thread notification failed", error);
    }
  }
}

function buildPrompt(
  task: TaskRecord,
  checkoutPath: string,
  featureBranch: string,
  instruction: string,
): string {
  return [
    `Task id: ${task.id}`,
    `Repository: ${task.repo}`,
    `Base branch: ${task.branch}`,
    `Feature branch: ${featureBranch}`,
    `Workspace: ${checkoutPath}`,
    `Model: ${task.model}`,
    "",
    instruction,
  ].join("\n");
}

function threadName(repo: string, taskId: string): string {
  return `threadcord-${repo.replace("/", "-")}-${taskId.slice(0, 8)}`.slice(
    0,
    90,
  );
}
