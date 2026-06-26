import { SlashCommandBuilder } from "discord.js";

export function buildTaskCommandJson(): ReturnType<
  SlashCommandBuilder["toJSON"]
> {
  const command = new SlashCommandBuilder()
    .setName("task")
    .setDescription("Create and manage Threadcord coding tasks.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription(
          "Start a new task (repo, branch, model, and instruction).",
        ),
    );
  return command.toJSON();
}