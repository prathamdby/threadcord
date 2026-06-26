import {
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { AppConfig } from "../config.js";
import { clampDiscordContent } from "../discord/limits.js";
import { summarizeError } from "../util/redact.js";
import {
  parseTaskCreateCustomId,
  pendingFromTaskCreateModal,
  taskCreateModal,
} from "./create-flow.js";
import type { TaskOrchestrator } from "./orchestrator.js";
import { toSetupThreadRef } from "../setup/discord-session.js";

function discordContent(content: string): string {
  return clampDiscordContent(content);
}

export async function handleTaskInteraction(input: {
  interaction: Interaction;
  orchestrator: TaskOrchestrator;
  config: AppConfig;
}): Promise<boolean> {
  const { interaction, orchestrator, config } = input;
  if (interaction.isChatInputCommand() && interaction.commandName === "task") {
    await handleTaskCommand(interaction, orchestrator, config);
    return true;
  }
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith("task:")
  ) {
    await handleTaskModal(interaction, orchestrator);
    return true;
  }
  return false;
}

async function handleTaskCommand(
  interaction: ChatInputCommandInteraction,
  orchestrator: TaskOrchestrator,
  config: AppConfig,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === "create") {
      await interaction.showModal(
        taskCreateModal(interaction.user.id, {
          model: config.defaultModel,
        }),
      );
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

async function handleTaskModal(
  interaction: ModalSubmitInteraction,
  orchestrator: TaskOrchestrator,
): Promise<void> {
  const parsed = parseTaskCreateCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "create") {
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

  const pending = pendingFromTaskCreateModal({
    repo: interaction.fields.getTextInputValue("repo"),
    branch: interaction.fields.getTextInputValue("branch"),
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
      onFailure: async (summary) => {
        await interaction.editReply(
          discordContent(`Could not start task: ${summary}`),
        );
      },
    });
    if (!result.ok) {
      await interaction.editReply(discordContent(`Rejected: ${result.reason}`));
      return;
    }
    const threadLink = `<#${result.threadId}>`;
    await interaction.editReply(
      discordContent(
        result.startedImmediately
          ? `Task started. Live log: ${threadLink}`
          : `Task queued. Live log: ${threadLink}`,
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