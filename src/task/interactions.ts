import {
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { AppConfig } from "../config.js";
import {
  errorView,
  infoView,
  parseCustomId,
  replyWithError,
  respond,
} from "../discord/ui/index.js";
import { summarizeError } from "../util/redact.js";
import { pendingFromTaskCreateModal } from "./create-flow.js";
import { toTaskThreadRef } from "./discord-thread.js";
import type { TaskOrchestrator } from "./orchestrator.js";
import type { SetupStore } from "../setup/store.js";
import {
  buildTaskCreateModal,
  parseTaskCreateModalCustomId,
  TASK_PROFILE_SELECT_MAX,
} from "./profile-select.js";
import { parseThreadControlButtonCustomId } from "./thread-controls.js";

function formatTaskStartFailure(reason: string): string {
  if (reason.startsWith("Could not create a thread")) {
    return reason;
  }
  if (reason.startsWith("Task thread created but the status message")) {
    return reason;
  }
  return reason.startsWith("Rejected:") ? reason.slice("Rejected:".length).trim() : reason;
}

function taskStartErrorKind(
  reason: string,
): "validation" | "rejection" | "internal" {
  if (
    reason.startsWith("Could not create a thread") ||
    reason.startsWith("Task thread created but the status message")
  ) {
    return "internal";
  }
  return "rejection";
}

export async function handleTaskInteraction(input: {
  interaction: Interaction;
  orchestrator: TaskOrchestrator;
  setupStore: SetupStore;
  config: AppConfig;
}): Promise<boolean> {
  const { interaction, orchestrator, setupStore, config } = input;
  if (interaction.isChatInputCommand() && interaction.commandName === "task") {
    await handleTaskCommand(interaction, setupStore, config);
    return true;
  }
  if (interaction.isButton()) {
    const parsed = parseCustomId(interaction.customId);
    if (parsed?.ns === "task" && parsed.action === "ctl") {
      await handleTaskControlButton(interaction, orchestrator);
      return true;
    }
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("task:")) {
    await handleTaskModal(interaction, orchestrator, setupStore);
    return true;
  }
  if (
    (interaction.isButton() ||
      interaction.isModalSubmit() ||
      interaction.isStringSelectMenu()) &&
    parseCustomId(interaction.customId)?.ns === "task"
  ) {
    await replyWithError(interaction, "validation", "Unknown task action.");
    return true;
  }
  return false;
}

async function handleTaskCommand(
  interaction: ChatInputCommandInteraction,
  setupStore: SetupStore,
  config: AppConfig,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === "create") {
      const profiles = await setupStore.listReadyProfiles(
        TASK_PROFILE_SELECT_MAX,
      );
      if (profiles.length === 0) {
        await replyWithError(
          interaction,
          "validation",
          "No ready setup profiles. Run `/setup create` for a repo and branch first.",
        );
        return;
      }
      await interaction.showModal(
        buildTaskCreateModal({
          userId: interaction.user.id,
          profiles,
          defaultModel: config.defaultModel,
        }),
      );
      return;
    }
    await replyWithError(
      interaction,
      "validation",
      `Unknown task subcommand: ${subcommand}`,
    );
  } catch (error) {
    await replyWithError(interaction, "internal", summarizeError(error));
  }
}

async function handleTaskModal(
  interaction: ModalSubmitInteraction,
  orchestrator: TaskOrchestrator,
  setupStore: SetupStore,
): Promise<void> {
  const parsed = parseTaskCreateModalCustomId(interaction.customId);
  if (!parsed) {
    await replyWithError(interaction, "validation", "Invalid task dialog.");
    return;
  }
  if (interaction.user.id !== parsed.userId) {
    await replyWithError(
      interaction,
      "rejection",
      "This task dialog belongs to another user.",
    );
    return;
  }

  const profileId = interaction.fields.getStringSelectValues("profile")[0];
  if (!profileId) {
    await replyWithError(interaction, "validation", "Select a setup profile.");
    return;
  }

  const profile = await setupStore.getProfileById(profileId);
  if (!profile || profile.status !== "ready") {
    await replyWithError(
      interaction,
      "validation",
      "Setup profile is not ready. Run `/task create` again.",
    );
    return;
  }

  const pending = pendingFromTaskCreateModal({
    repo: profile.repo,
    branch: profile.branch,
    model: interaction.fields.getTextInputValue("model"),
    instruction: interaction.fields.getTextInputValue("instruction"),
  });

  if (!pending.instruction) {
    await replyWithError(interaction, "validation", "Task instruction is required.");
    return;
  }

  await interaction.deferReply();
  try {
    const result = await orchestrator.startTaskFromSlash({
      initiatorMessageId: interaction.id,
      pending,
      createThread: async (name) => {
        const anchor = await interaction.fetchReply();
        const thread = await anchor.startThread({
          name,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        });
        return toTaskThreadRef(thread);
      },
    });
    if (!result.ok) {
      const detail = formatTaskStartFailure(result.reason);
      await interaction.editReply(
        errorView(taskStartErrorKind(result.reason), detail),
      );
      return;
    }
    const threadLink = `<#${result.threadId}>`;
    const title = result.startedImmediately ? "Task started" : "Task queued";
    const body = result.startedImmediately
      ? `Task started for ${profile.repo}@${profile.branch}. Live log: ${threadLink}`
      : `Task queued for ${profile.repo}@${profile.branch}. Live log: ${threadLink}`;
    await interaction.editReply(infoView(title, body));
  } catch (error) {
    try {
      await interaction.editReply(
        errorView("internal", summarizeError(error)),
      );
    } catch {
      console.error("[threadcord] task create editReply failed", error);
    }
  }
}

async function handleTaskControlButton(
  interaction: ButtonInteraction,
  orchestrator: TaskOrchestrator,
): Promise<void> {
  const parsed = parseThreadControlButtonCustomId(interaction.customId);
  if (!parsed) {
    await replyWithError(interaction, "validation", "Invalid task control.");
    return;
  }
  let deferred = false;
  await orchestrator.handleControlButton({
    customId: interaction.customId,
    userId: interaction.user.id,
    defer: async () => {
      await interaction.deferUpdate();
      deferred = true;
    },
    update: async (payload) => {
      if (deferred) {
        await interaction.editReply(payload);
        return;
      }
      await interaction.update(payload);
    },
    reply: async (payload) => {
      await respond(interaction, payload);
    },
  });
}
