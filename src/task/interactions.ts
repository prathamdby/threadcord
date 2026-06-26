import {
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { AppConfig } from "../config.js";
import { clampDiscordContent } from "../discord/limits.js";
import { summarizeError } from "../util/redact.js";
import { pendingFromTaskCreateModal } from "./create-flow.js";
import type { TaskOrchestrator } from "./orchestrator.js";
import { toSetupThreadRef } from "../setup/discord-session.js";
import type { SetupStore } from "../setup/store.js";
import {
  buildReadyProfileSelectRow,
  parseProfileSelectCustomId,
  parseTaskCreateModalCustomId,
  taskInstructionModal,
  TASK_PROFILE_SELECT_MAX,
} from "./profile-select.js";

function discordContent(content: string): string {
  return clampDiscordContent(content);
}

function formatTaskStartFailure(reason: string): string {
  if (reason.startsWith("Could not create a thread")) {
    return reason;
  }
  if (reason.startsWith("Task thread created but the status message")) {
    return reason;
  }
  return `Rejected: ${reason}`;
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
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("task:")) {
    await handleTaskProfileSelect(interaction, setupStore, config);
    return true;
  }
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith("task:")
  ) {
    await handleTaskModal(interaction, orchestrator, setupStore);
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
        await interaction.reply({
          content: discordContent(
            "No ready setup profiles. Run `/setup create` for a repo and branch first.",
          ),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const row = buildReadyProfileSelectRow(interaction.user.id, profiles);
      if (!row) {
        await interaction.reply({
          content: discordContent("No setup profiles available."),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: discordContent(
          "Pick a repository and base branch (from ready setup profiles), then enter model and instruction.",
        ),
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: discordContent(`Unknown task subcommand: ${subcommand}`),
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await replyWithError(interaction, summarizeError(error));
  }
}

async function handleTaskProfileSelect(
  interaction: StringSelectMenuInteraction,
  setupStore: SetupStore,
  config: AppConfig,
): Promise<void> {
  const parsed = parseProfileSelectCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      content: discordContent("Invalid task profile picker."),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      content: discordContent("This picker belongs to another user."),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const profileId = interaction.values[0];
  if (!profileId) {
    await interaction.reply({
      content: discordContent("Select a setup profile."),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const profile = await setupStore.getProfileById(profileId);
  if (!profile || profile.status !== "ready") {
    await interaction.reply({
      content: discordContent(
        "That setup profile is no longer ready. Run `/task create` again.",
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.showModal(
    taskInstructionModal({
      userId: interaction.user.id,
      profile,
      defaultModel: config.defaultModel,
    }),
  );
}

async function handleTaskModal(
  interaction: ModalSubmitInteraction,
  orchestrator: TaskOrchestrator,
  setupStore: SetupStore,
): Promise<void> {
  const parsed = parseTaskCreateModalCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "modal") {
    await interaction.reply({
      content: discordContent("Invalid task dialog."),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      content: discordContent("This task dialog belongs to another user."),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const profile = await setupStore.getProfileById(parsed.profileId);
  if (!profile || profile.status !== "ready") {
    await interaction.reply({
      content: discordContent(
        "Setup profile is not ready. Run `/task create` again.",
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const pending = pendingFromTaskCreateModal({
    repo: profile.repo,
    branch: profile.branch,
    model: interaction.fields.getTextInputValue("model"),
    instruction: interaction.fields.getTextInputValue("instruction"),
  });

  if (!pending.instruction) {
    await interaction.reply({
      content: discordContent("Task instruction is required."),
      flags: MessageFlags.Ephemeral,
    });
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
        return toSetupThreadRef(thread);
      },
    });
    if (!result.ok) {
      await interaction.editReply(
        discordContent(formatTaskStartFailure(result.reason)),
      );
      return;
    }
    const threadLink = `<#${result.threadId}>`;
    await interaction.editReply(
      discordContent(
        result.startedImmediately
          ? `Task started for ${profile.repo}@${profile.branch}. Live log: ${threadLink}`
          : `Task queued for ${profile.repo}@${profile.branch}. Live log: ${threadLink}`,
      ),
    );
  } catch (error) {
    try {
      await interaction.editReply(
        discordContent(`Task failed: ${summarizeError(error)}`),
      );
    } catch {
      console.error("[threadcord] task create editReply failed", error);
    }
  }
}

async function replyWithError(
  interaction: ChatInputCommandInteraction,
  message: string,
): Promise<void> {
  const content = discordContent(`Task failed: ${message}`);
  try {
    if (interaction.deferred) {
      await interaction.editReply(content);
      return;
    }
    if (interaction.replied) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
    });
  } catch {
    return;
  }
}