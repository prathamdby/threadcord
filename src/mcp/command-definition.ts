import { SlashCommandBuilder } from "discord.js";

export function buildMcpCommandJson(): ReturnType<
  SlashCommandBuilder["toJSON"]
> {
  const command = new SlashCommandBuilder()
    .setName("mcp")
    .setDescription("Manage global MCP tool servers.")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription(
          "Add an MCP server (opens a configuration dialog).",
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove an MCP server by id.")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("Server id to remove")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List configured MCP servers."),
    );
  return command.toJSON();
}
