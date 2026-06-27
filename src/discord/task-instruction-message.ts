import { DISCORD_MESSAGE_CONTENT_LIMIT } from "./limits.js";

export function formatTaskInstructionForDiscord(
  instruction: string | undefined | null,
): string {
  const body = (instruction ?? "").trim();
  if (!body) return "";

  const header = "**Task instruction**\n";
  const maxBodyLength = DISCORD_MESSAGE_CONTENT_LIMIT - header.length - 3;

  if (body.length > maxBodyLength) {
    return header + body.slice(0, maxBodyLength) + "...";
  }
  return header + body;
}