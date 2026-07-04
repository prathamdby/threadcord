import { LabelBuilder, ModalBuilder, StringSelectMenuBuilder } from "discord.js";
import {
  buildCustomId,
  modalRow,
  parseCustomId,
  truncate,
} from "../discord/ui/index.js";
import {
  buildModelSelectMenu,
  MODEL_SELECT_MAX,
} from "../discord/ui/model-select.js";
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

export const TASK_MODEL_SELECT_MAX = MODEL_SELECT_MAX;

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

  const modelSelect = buildModelSelectMenu({ allowedModels, defaultModel });

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
