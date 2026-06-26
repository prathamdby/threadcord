import {
  ActionRowBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { SetupProfile } from "../setup/profile.js";

const TASK_PREFIX = "task:";

export const TASK_PROFILE_SELECT_MAX = 25;

export function profileSelectCustomId(userId: string): string {
  return `${TASK_PREFIX}sel:profile:${userId}`;
}

export function parseProfileSelectCustomId(
  customId: string,
): { userId: string } | undefined {
  if (!customId.startsWith(TASK_PREFIX)) return undefined;
  const rest = customId.slice(TASK_PREFIX.length);
  if (!rest.startsWith("sel:profile:")) return undefined;
  const userId = rest.slice("sel:profile:".length);
  return userId ? { userId } : undefined;
}

export function taskCreateModalCustomId(
  userId: string,
  profileId: string,
): string {
  return `${TASK_PREFIX}create:modal:${userId}:${profileId}`;
}

export function parseTaskCreateModalCustomId(
  customId: string,
):
  | { kind: "modal"; userId: string; profileId: string }
  | undefined {
  if (!customId.startsWith(TASK_PREFIX)) return undefined;
  const rest = customId.slice(TASK_PREFIX.length);
  const parts = rest.split(":");
  if (parts[0] === "create" && parts[1] === "modal" && parts.length === 4) {
    const userId = parts[2];
    const profileId = parts[3];
    if (!userId || !profileId) return undefined;
    return { kind: "modal", userId, profileId };
  }
  return undefined;
}

export function buildReadyProfileSelectRow(
  userId: string,
  profiles: SetupProfile[],
): ActionRowBuilder<StringSelectMenuBuilder> | undefined {
  if (profiles.length === 0) return undefined;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(profileSelectCustomId(userId))
    .setPlaceholder("Choose a setup profile (repo @ branch)")
    .addOptions(
      profiles.slice(0, TASK_PROFILE_SELECT_MAX).map((profile) => ({
        label: truncate(profileLabel(profile), 100),
        description: truncate(`Ready · rev ${profile.revision}`, 100),
        value: profile.id,
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function taskInstructionModal(input: {
  userId: string;
  profile: SetupProfile;
  defaultModel: string;
}): ModalBuilder {
  const { userId, profile, defaultModel } = input;
  return new ModalBuilder()
    .setCustomId(taskCreateModalCustomId(userId, profile.id))
    .setTitle(truncate(`Task: ${profile.repo}@${profile.branch}`, 45))
    .addComponents(
      modalRow(
        "model",
        "Model (provider/model-id)",
        defaultModel,
        100,
        true,
        TextInputStyle.Short,
      ),
      modalRow(
        "instruction",
        "Task instruction",
        "",
        4000,
        true,
        TextInputStyle.Paragraph,
      ),
    );
}

function profileLabel(profile: SetupProfile): string {
  return `${profile.repo} @ ${profile.branch}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function modalRow(
  customId: string,
  label: string,
  value: string,
  maxLength: number,
  required: boolean,
  style: TextInputStyle = TextInputStyle.Paragraph,
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label.slice(0, 45))
      .setValue(value.slice(0, maxLength))
      .setMaxLength(maxLength)
      .setRequired(required)
      .setStyle(style),
  );
}