import type { Client } from "discord.js";
import { buildSetupCommandJson } from "../setup/command-definition.js";
import { buildTaskCommandJson } from "../task/command-definition.js";

export async function registerDiscordCommands(client: Client): Promise<void> {
  await client.application?.commands.set([
    buildSetupCommandJson(),
    buildTaskCommandJson(),
  ]);
}
