import {
  MessageFlags,
  ModalBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { McpTransport } from "@flue/runtime";
import type { McpPool, McpServerConfig } from "../flue/mcp.js";
import {
  confirmView,
  ensureDeferred,
  errorView,
  infoView,
  modalRow,
  parseCustomId,
  replyWithError,
  respond,
  selectMenuRow,
  viewWithRows,
  type ViewPayload,
} from "../discord/ui/index.js";
import { summarizeError } from "../util/redact.js";
import {
  mcpAddModalId,
  mcpRemoveCancelId,
  mcpRemoveConfirmId,
  mcpRemoveSelectId,
  parseMcpAddModalId,
  parseMcpListPageId,
  parseMcpRemoveCancelId,
  parseMcpRemoveConfirmId,
  parseMcpRemoveSelectId,
} from "./custom-id.js";
import type { McpStore, McpServerRow } from "./store.js";
import { buildHeaders, validateAddInputs } from "./validation.js";
import { mcpListView } from "./views.js";

function withEphemeral(payload: ViewPayload): ViewPayload {
  return { ...payload, flags: payload.flags | MessageFlags.Ephemeral };
}

export async function handleMcpInteraction(input: {
  interaction: Interaction;
  store: McpStore;
  pool: McpPool;
}): Promise<boolean> {
  const { interaction, store, pool } = input;
  if (interaction.isChatInputCommand() && interaction.commandName === "mcp") {
    await handleMcpCommand(interaction, store);
    return true;
  }
  if (interaction.isModalSubmit()) {
    const parsed = parseMcpAddModalId(interaction.customId);
    if (parsed) {
      await handleMcpAddModal(interaction, store, pool);
      return true;
    }
  }
  if (interaction.isStringSelectMenu()) {
    const parsed = parseMcpRemoveSelectId(interaction.customId);
    if (parsed) {
      await handleMcpRemoveSelect(interaction, store, parsed.userId);
      return true;
    }
  }
  if (interaction.isButton()) {
    const confirm = parseMcpRemoveConfirmId(interaction.customId);
    if (confirm) {
      await handleMcpRemoveConfirm(interaction, store, pool, confirm);
      return true;
    }
    const cancel = parseMcpRemoveCancelId(interaction.customId);
    if (cancel) {
      await handleMcpRemoveCancel(interaction, cancel);
      return true;
    }
    const page = parseMcpListPageId(interaction.customId);
    if (page) {
      await handleMcpListPage(interaction, store, page);
      return true;
    }
  }
  if (
    (interaction.isButton() ||
      interaction.isModalSubmit() ||
      interaction.isStringSelectMenu()) &&
    parseCustomId(interaction.customId)?.ns === "mcp"
  ) {
    await replyWithError(interaction, "validation", "Unknown MCP action.");
    return true;
  }
  return false;
}

async function handleMcpCommand(
  interaction: ChatInputCommandInteraction,
  store: McpStore,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === "add") {
      await interaction.showModal(mcpAddModal(interaction.user.id));
      return;
    }
    if (subcommand === "remove") {
      await handleMcpRemoveCommand(interaction, store);
      return;
    }
    if (subcommand === "list") {
      await handleMcpListCommand(interaction, store);
      return;
    }
    await replyWithError(
      interaction,
      "validation",
      `Unknown mcp subcommand: ${subcommand}`,
    );
  } catch (error) {
    await replyWithError(interaction, "internal", summarizeError(error));
  }
}

async function handleMcpRemoveCommand(
  interaction: ChatInputCommandInteraction,
  store: McpStore,
): Promise<void> {
  await ensureDeferred(interaction);
  const servers = await store.listServers();
  if (servers.length === 0) {
    await replyWithError(
      interaction,
      "validation",
      "No MCP servers configured.",
    );
    return;
  }

  const userId = interaction.user.id;
  const selectRow = selectMenuRow(
    mcpRemoveSelectId(userId),
    "Choose a server to remove",
    servers.map((server) => ({
      label: server.id,
      value: server.id,
      description: server.url.slice(0, 100),
    })),
  );
  await respond(
    interaction,
    viewWithRows(
      "Remove MCP Server",
      "Select the server you want to remove.",
      [selectRow],
    ),
  );
}

async function handleMcpRemoveSelect(
  interaction: StringSelectMenuInteraction,
  store: McpStore,
  expectedUserId: string,
): Promise<void> {
  if (interaction.user.id !== expectedUserId) {
    await replyWithError(
      interaction,
      "rejection",
      "This picker belongs to another user.",
    );
    return;
  }

  const serverId = interaction.values[0];
  if (!serverId) {
    await replyWithError(interaction, "validation", "Select an MCP server.");
    return;
  }

  const server = await store.getServer(serverId);
  if (!server) {
    await replyWithError(
      interaction,
      "validation",
      `MCP server \`${serverId}\` not found.`,
    );
    return;
  }

  await interaction.update(
    withEphemeral(confirmRemoveView(server, interaction.user.id)),
  );
}

function confirmRemoveView(server: McpServerRow, userId: string): ViewPayload {
  return confirmView(
    `Remove server \`${server.id}\` (${server.url})?`,
    mcpRemoveConfirmId(userId, server.id),
    mcpRemoveCancelId(userId, server.id),
  );
}

async function handleMcpRemoveConfirm(
  interaction: ButtonInteraction,
  store: McpStore,
  pool: McpPool,
  parsed: { userId: string; serverId: string },
): Promise<void> {
  if (interaction.user.id !== parsed.userId) {
    await replyWithError(
      interaction,
      "rejection",
      "This confirmation belongs to another user.",
    );
    return;
  }

  const { serverId, userId } = parsed;
  await interaction.deferUpdate();

  const existing = await store.getServer(serverId);
  const removedFromPool = await pool.removeServer(serverId);

  if (!existing && !removedFromPool) {
    await interaction.editReply(
      errorView("validation", `MCP server \`${serverId}\` not found.`),
    );
    return;
  }

  try {
    const removedFromDb = await store.removeServer(serverId);
    if (removedFromDb || removedFromPool) {
      await interaction.editReply(
        infoView("Removed", `MCP server \`${serverId}\` was removed.`),
      );
      return;
    }
    await interaction.editReply(
      errorView("validation", `MCP server \`${serverId}\` not found.`),
    );
  } catch (error) {
    if (existing && removedFromPool) {
      try {
        await pool.addServer(serverRowToPoolConfig(existing));
      } catch (rollbackError) {
        console.warn(
          `[threadcord] Failed to restore MCP server "${serverId}" after remove error`,
          rollbackError,
        );
      }
    }
    await interaction.editReply(
      errorView(
        "internal",
        `Failed to remove MCP server \`${serverId}\`: ${summarizeError(error)}`,
      ),
    );
  }
}

async function handleMcpRemoveCancel(
  interaction: ButtonInteraction,
  parsed: { userId: string; serverId: string },
): Promise<void> {
  if (interaction.user.id !== parsed.userId) {
    await replyWithError(
      interaction,
      "rejection",
      "This confirmation belongs to another user.",
    );
    return;
  }

  const { serverId, userId } = parsed;
  await interaction.update(
    withEphemeral(infoView("Cancelled", "Removal cancelled.")),
  );
}

async function handleMcpListCommand(
  interaction: ChatInputCommandInteraction,
  store: McpStore,
): Promise<void> {
  await ensureDeferred(interaction);
  const servers = await store.listServers();
  if (servers.length === 0) {
    await respond(
      interaction,
      infoView("MCP Servers", "No MCP servers configured."),
    );
    return;
  }
  await respond(
    interaction,
    mcpListView(servers, 0, interaction.user.id),
  );
}

async function handleMcpListPage(
  interaction: ButtonInteraction,
  store: McpStore,
  parsed: { userId: string; page: number },
): Promise<void> {
  if (interaction.user.id !== parsed.userId) {
    await replyWithError(
      interaction,
      "rejection",
      "This list belongs to another user.",
    );
    return;
  }

  const servers = await store.listServers();
  await interaction.update(
    withEphemeral(mcpListView(servers, parsed.page, parsed.userId)),
  );
}

async function handleMcpAddModal(
  interaction: ModalSubmitInteraction,
  store: McpStore,
  pool: McpPool,
): Promise<void> {
  const parsed = parseMcpAddModalId(interaction.customId);
  if (!parsed) {
    await replyWithError(interaction, "validation", "Invalid MCP modal.");
    return;
  }
  if (interaction.user.id !== parsed.userId) {
    await replyWithError(
      interaction,
      "rejection",
      "This dialog belongs to another user.",
    );
    return;
  }

  await ensureDeferred(interaction);

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
      await replyWithError(interaction, "validation", validated.message);
      return;
    }

    if (await store.getServer(id)) {
      await replyWithError(
        interaction,
        "validation",
        `MCP server \`${id}\` already exists.`,
      );
      return;
    }

    const { config } = validated;
    try {
      const connection = await pool.addServer(config);
      const toolCount = connection.tools.length;
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
        await respond(
          interaction,
          infoView(
            "MCP Server added",
            `MCP server \`${id}\` connected (${toolCount} tool${toolCount === 1 ? "" : "s"} available).`,
          ),
        );
      } catch (error) {
        let rollbackNote = "";
        try {
          await pool.removeServer(id);
        } catch (rollbackError) {
          rollbackNote =
            " (cleanup failed; server may still be connected in memory).";
          console.warn(
            `[threadcord] Failed to roll back MCP server "${id}" after save error`,
            rollbackError,
          );
        }
        await replyWithError(
          interaction,
          "rejection",
          `Connected but failed to save: ${summarizeError(error)}${rollbackNote}`,
        );
      }
    } catch (error) {
      await replyWithError(
        interaction,
        "validation",
        `Failed to connect to MCP server \`${id}\`: ${summarizeError(error)}`,
      );
    }
  } catch (error) {
    await replyWithError(interaction, "internal", summarizeError(error));
  }
}

function mcpAddModal(userId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(mcpAddModalId(userId))
    .setTitle("Add MCP Server")
    .addLabelComponents(
      modalRow("id", "Server ID (lowercase, hyphens)", {
        style: "short",
        required: true,
        maxLength: 50,
      }),
      modalRow("url", "Server URL", {
        style: "short",
        required: true,
        maxLength: 4000,
      }),
      modalRow("token", "Bearer token (optional)", {
        style: "short",
        maxLength: 4000,
      }),
      modalRow("transport", "Transport (streamable-http or sse)", {
        style: "short",
        maxLength: 20,
      }),
      modalRow("headers", "Headers JSON (optional)", {
        maxLength: 4000,
      }),
    );
}

function serverRowToPoolConfig(row: McpServerRow): McpServerConfig {
  const mergedHeaders = buildHeaders(row.headers, row.token);
  return {
    id: row.id,
    url: row.url,
    ...(row.transport ? { transport: row.transport as McpTransport } : {}),
    ...(mergedHeaders ? { headers: mergedHeaders } : {}),
  };
}
