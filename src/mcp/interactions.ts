import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import { clampDiscordContent } from "../discord/limits.js";
import { summarizeError } from "../util/redact.js";
import type { McpPool } from "../flue/mcp.js";
import type { McpStore } from "./store.js";
import { validateAddInputs } from "./validation.js";

const MCP_CUSTOM_ID_PREFIX = "mcp:";

function discordContent(content: string): string {
  return clampDiscordContent(content);
}

export async function handleMcpInteraction(input: {
  interaction: Interaction;
  store: McpStore;
  pool: McpPool;
}): Promise<boolean> {
  const { interaction, store, pool } = input;
  if (interaction.isChatInputCommand() && interaction.commandName === "mcp") {
    await handleMcpCommand(interaction, store, pool);
    return true;
  }
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith(MCP_CUSTOM_ID_PREFIX)
  ) {
    await handleMcpModal(interaction, store, pool);
    return true;
  }
  return false;
}

async function handleMcpCommand(
  interaction: ChatInputCommandInteraction,
  store: McpStore,
  pool: McpPool,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === "add") {
      await interaction.showModal(mcpAddModal(interaction.user.id));
      return;
    }
    if (subcommand === "remove") {
      await handleRemove(interaction, store, pool);
      return;
    }
    if (subcommand === "list") {
      await handleList(interaction, store);
      return;
    }
    await interaction.reply({
      content: discordContent(`Unknown mcp subcommand: ${subcommand}`),
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await replyWithError(interaction, summarizeError(error));
  }
}

async function handleRemove(
  interaction: ChatInputCommandInteraction,
  store: McpStore,
  pool: McpPool,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.options.getString("id", true).trim();
  const removedFromDb = await store.removeServer(id);
  const removedFromPool = await pool.removeServer(id);
  if (removedFromDb || removedFromPool) {
    await interaction.editReply(
      discordContent(`Removed MCP server \`${id}\`.`),
    );
  } else {
    await interaction.editReply(
      discordContent(`MCP server \`${id}\` not found.`),
    );
  }
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  store: McpStore,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const servers = await store.listServers();
  if (servers.length === 0) {
    await interaction.editReply(
      discordContent("(no MCP servers configured)"),
    );
    return;
  }
  const lines = servers.map((server) => {
    const transport = server.transport ?? "streamable-http";
    return `• \`${server.id}\` — ${server.url} (${transport})`;
  });
  await interaction.editReply(
    discordContent(
      `**MCP Servers (${servers.length})**\n${lines.join("\n")}`,
    ),
  );
}

async function handleMcpModal(
  interaction: ModalSubmitInteraction,
  store: McpStore,
  pool: McpPool,
): Promise<void> {
  if (!interaction.customId.startsWith(`${MCP_CUSTOM_ID_PREFIX}add:`)) {
    await interaction.reply({
      content: discordContent("Invalid MCP modal."),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const expectedUserId = interaction.customId.slice(
    `${MCP_CUSTOM_ID_PREFIX}add:`.length,
  );
  if (interaction.user.id !== expectedUserId) {
    await interaction.reply({
      content: discordContent("This dialog belongs to another user."),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let replyContent: string | undefined;
  try {
    const id = interaction.fields.getTextInputValue("id").trim();
    const url = interaction.fields.getTextInputValue("url").trim();
    const tokenRaw = interaction.fields.getTextInputValue("token").trim();
    const transportRaw = interaction.fields
      .getTextInputValue("transport")
      .trim();
    const headersRaw = interaction.fields.getTextInputValue("headers").trim();

    const validated = validateAddInputs(
      id,
      url,
      tokenRaw,
      transportRaw,
      headersRaw,
    );
    if (!validated.ok) {
      replyContent = validated.message;
      return;
    }

    const { config } = validated;

    if (await store.getServer(id)) {
      replyContent = `MCP server \`${id}\` already exists.`;
      return;
    }

    let toolCount: number;
    try {
      const connection = await pool.addServer(config);
      toolCount = connection.tools.length;
    } catch (error) {
      replyContent = `Failed to connect to MCP server \`${id}\`: ${summarizeError(error)}`;
      return;
    }

    try {
      await store.addServer({
        id,
        url,
        ...(validated.config.transport
          ? { transport: validated.config.transport }
          : {}),
        ...(validated.customHeaders
          ? { headers: validated.customHeaders }
          : {}),
        ...(validated.token ? { token: validated.token } : {}),
      });
    } catch (error) {
      await pool.removeServer(id);
      replyContent = `Connected but failed to save: ${summarizeError(error)}`;
      return;
    }

    replyContent = `MCP server \`${id}\` connected (${toolCount} tool${toolCount === 1 ? "" : "s"} available).`;
  } catch (error) {
    replyContent =
      replyContent ?? `MCP add failed: ${summarizeError(error)}`;
  }

  await interaction
    .editReply(discordContent(replyContent ?? "MCP add failed."))
    .catch(() => {});
}

function mcpAddModal(userId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${MCP_CUSTOM_ID_PREFIX}add:${userId}`)
    .setTitle("Add MCP Server")
    .addComponents(
      modalRow("id", "Server ID (lowercase, hyphens)", "", 100, true),
      modalRow("url", "Server URL", "", 4000, true),
      modalRow(
        "token",
        "Bearer token (optional)",
        "",
        4000,
        false,
        TextInputStyle.Short,
      ),
      modalRow(
        "transport",
        "Transport (streamable-http or sse)",
        "",
        20,
        false,
        TextInputStyle.Short,
      ),
      modalRow("headers", "Headers JSON (optional)", "", 4000, false),
    );
}

function modalRow(
  customId: string,
  label: string,
  value: string,
  maxLength: number,
  required: boolean,
  style: TextInputStyle = TextInputStyle.Short,
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setValue(value)
      .setMaxLength(maxLength)
      .setRequired(required)
      .setStyle(style),
  );
}

async function replyWithError(
  interaction: ChatInputCommandInteraction,
  message: string,
): Promise<void> {
  const content = discordContent(`MCP command failed: ${message}`);
  try {
    if (interaction.deferred) {
      await interaction.editReply(content);
      return;
    }
    if (interaction.replied) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
    });
  } catch {
    return;
  }
}
