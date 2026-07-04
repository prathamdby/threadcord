import {
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  buildCustomId,
  modalRow,
  parseCustomId,
} from "../discord/ui/index.js";
import type { SetupProfile } from "../setup/profile.js";

export const TASK_PROFILE_SELECT_MAX = 25;

export function taskCreateModalCustomId(userId: string): string {
  return buildCustomId("task", "create", "modal", userId);
}

export function parseTaskCreateModalCustomId(
  customId: string,
): { userId: string } | undefined {
  const parsed = parseCustomId(customId);
  if (
    !parsed ||
    parsed.action !== "create" ||
    parsed.params[0] !== "modal"
  ) {
    return undefined;
  }
  const userId = parsed.params[1];
  return userId ? { userId } : undefined;
}

export const TASK_MODEL_SELECT_MAX = 25;

export function buildTaskCreateModal(input: {
  userId: string;
  profiles: SetupProfile[];
  allowedModels: string[];
  defaultModel: string;
}): ModalBuilder {
  const { userId, profiles, allowedModels, defaultModel } = input;
  const profileSelect = new StringSelectMenuBuilder()
    .setCustomId("profile")
    .setPlaceholder("Choose a setup profile (repo @ branch)")
    .addOptions(
      profiles.slice(0, TASK_PROFILE_SELECT_MAX).map((profile) => ({
        label: truncate(profileLabel(profile), 100),
        description: truncate(`Ready · rev ${profile.revision}`, 100),
        value: profile.id,
      })),
    );

  const modelSelect = new StringSelectMenuBuilder()
    .setCustomId("model")
    .setPlaceholder("Choose a model (provider/model-id)")
    .addOptions(
      allowedModels.slice(0, TASK_MODEL_SELECT_MAX).map((modelId) => ({
        label: truncate(modelId, 100),
        value: modelId,
        ...(modelId === defaultModel ? { default: true } : {}),
      })),
    );

  return new ModalBuilder()
    .setCustomId(taskCreateModalCustomId(userId))
    .setTitle("Create task")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Setup profile")
        .setStringSelectMenuComponent(profileSelect),
      new LabelBuilder()
        .setLabel("Model")
        .setStringSelectMenuComponent(modelSelect),
      modalRow("instruction", "Task instruction", {
        style: "paragraph",
        required: true,
      }),
    );
}

function profileLabel(profile: SetupProfile): string {
  return `${profile.repo} @ ${profile.branch}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
