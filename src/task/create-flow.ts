import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

const TASK_PREFIX = "task:";

export interface PendingTaskCreate {
  repo: string;
  branch: string;
  instruction: string;
  model: string;
}

export function taskCreateModal(
  userId: string,
  defaults?: Partial<PendingTaskCreate>,
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${TASK_PREFIX}create:${userId}`)
    .setTitle("Create task")
    .addComponents(
      modalRow(
        "repo",
        "Repository (owner/repo)",
        defaults?.repo ?? "",
        100,
        true,
        TextInputStyle.Short,
      ),
      modalRow(
        "branch",
        "Base branch",
        defaults?.branch ?? "main",
        100,
        true,
        TextInputStyle.Short,
      ),
      modalRow(
        "model",
        "Model (provider/model-id)",
        defaults?.model ?? "",
        100,
        true,
        TextInputStyle.Short,
      ),
      modalRow(
        "instruction",
        "Task instruction",
        defaults?.instruction ?? "",
        4000,
        true,
        TextInputStyle.Paragraph,
      ),
    );
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

export function pendingFromTaskCreateModal(input: {
  repo: string;
  branch: string;
  model: string;
  instruction: string;
}): PendingTaskCreate {
  return {
    repo: input.repo.trim(),
    branch: input.branch.trim(),
    model: input.model.trim(),
    instruction: input.instruction.trim(),
  };
}

export function parseTaskCreateCustomId(
  customId: string,
): { kind: "create"; userId: string } | undefined {
  if (!customId.startsWith(TASK_PREFIX)) return undefined;
  const rest = customId.slice(TASK_PREFIX.length);
  const parts = rest.split(":");
  if (parts[0] === "create" && parts.length === 2) {
    const userId = parts[1];
    if (!userId) return undefined;
    return { kind: "create", userId };
  }
  return undefined;
}