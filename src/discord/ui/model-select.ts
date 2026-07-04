import { StringSelectMenuBuilder } from "discord.js";

/** Maximum number of options Discord allows in a single string select menu. */
export const MODEL_SELECT_MAX = 25;

const SELECT_LABEL_LIMIT = 100;

export interface BuildModelSelectMenuInput {
  allowedModels: string[];
  defaultModel: string;
}

/**
 * Builds the shared "model" `StringSelectMenu` used by the `/task create` and
 * `/setup create` dialogs so both flows pick the model from the exact same
 * component.
 *
 * The default model is prepended and the list is deduplicated so it is always
 * the first option and is never silently sliced out when the list exceeds 25
 * entries. This also guarantees at least one option even if a caller forgets to
 * include the default in `allowedModels`.
 */
export function buildModelSelectMenu(
  input: BuildModelSelectMenuInput,
): StringSelectMenuBuilder {
  const { allowedModels, defaultModel } = input;
  const uniqueModels = [...new Set([defaultModel, ...allowedModels])].filter(
    Boolean,
  );
  return new StringSelectMenuBuilder()
    .setCustomId("model")
    .setPlaceholder("Choose a model (provider/model-id)")
    .addOptions(
      uniqueModels.slice(0, MODEL_SELECT_MAX).map((modelId) => ({
        label: truncate(modelId, SELECT_LABEL_LIMIT),
        value: modelId,
        ...(modelId === defaultModel ? { default: true } : {}),
      })),
    );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}