import { SlashCommandBuilder } from "discord.js";

export function buildSetupCommandJson(): ReturnType<
  SlashCommandBuilder["toJSON"]
> {
  const command = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Manage durable Threadcord setup profiles.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription(
          "Run setup for a repository and branch (opens a configuration dialog).",
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("update")
        .setDescription(
          "Re-run setup and replace the profile on success (opens a dialog).",
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show setup status.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("branch")
            .setDescription("Base branch")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("View the active setup profile.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("branch")
            .setDescription("Base branch")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("edit")
        .setDescription("Open a draft editor for the active setup profile.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("branch")
            .setDescription("Base branch")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("export")
        .setDescription("Export setup environment JSON and memory Markdown.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("branch")
            .setDescription("Base branch")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("import")
        .setDescription("Import environment JSON or memory Markdown as a draft.")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/repo").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("branch")
            .setDescription("Base branch")
            .setRequired(true),
        )
        .addAttachmentOption((option) =>
          option.setName("environment").setDescription("Environment JSON file"),
        )
        .addAttachmentOption((option) =>
          option.setName("memory").setDescription("Memory Markdown file"),
        ),
    );
  return command.toJSON();
}