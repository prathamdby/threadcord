import { MessageFlags, type RepliableInteraction } from "discord.js";
import { errorView, type ErrorKind, type ViewPayload } from "./views.js";

export interface RespondOptions {
  ephemeral?: boolean;
}

function withEphemeral(payload: ViewPayload, ephemeral: boolean): ViewPayload {
  return ephemeral
    ? { ...payload, flags: payload.flags | MessageFlags.Ephemeral }
    : payload;
}

export async function ensureDeferred(
  interaction: RepliableInteraction,
  opts: RespondOptions = {},
): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  const ephemeral = opts.ephemeral ?? true;
  await interaction.deferReply(
    ephemeral ? { flags: MessageFlags.Ephemeral } : {},
  );
}

export async function respond(
  interaction: RepliableInteraction,
  payload: ViewPayload,
  opts: RespondOptions = {},
): Promise<void> {
  const ephemeral = opts.ephemeral ?? true;
  const body = withEphemeral(payload, ephemeral);
  try {
    if (interaction.deferred) {
      await interaction.editReply(payload);
      return;
    }
    if (interaction.replied) {
      await interaction.followUp(body);
      return;
    }
    await interaction.reply(body);
  } catch (error) {
    if (!interaction.deferred && !interaction.replied) throw error;
    await interaction.followUp(body);
  }
}

export async function replyWithError(
  interaction: RepliableInteraction,
  kind: ErrorKind,
  detail?: string,
): Promise<void> {
  const body = withEphemeral(errorView(kind, detail), true);
  try {
    if (interaction.deferred) {
      await interaction.editReply(errorView(kind, detail));
      return;
    }
    if (interaction.replied) {
      await interaction.followUp(body);
      return;
    }
    await interaction.reply(body);
  } catch {
    if (!interaction.deferred && !interaction.replied) return;
    try {
      await interaction.followUp(body);
    } catch {
      return;
    }
  }
}
