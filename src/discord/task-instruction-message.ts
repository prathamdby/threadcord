import { clampDiscordContent } from "./limits.js";

export function formatTaskInstructionForDiscord(instruction: string): string {
  const body = instruction.trim();
  if (!body) return "";
  return clampDiscordContent(`**Task instruction**\n${body}`);
}