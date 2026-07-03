import { SlashCommandBuilder } from "discord.js";

export function buildTaskCommandJson(): ReturnType<
  SlashCommandBuilder["toJSON"]
> {
  const command = new SlashCommandBuilder()
    .setName("task")
    .setDescription("Create and manage Threadcord coding tasks.")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription(
          "Create a task: pick a setup profile, model, and instruction.",
        ),
    );
  return command.toJSON();
}
