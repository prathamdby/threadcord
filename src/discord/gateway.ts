import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
} from "discord.js";
import type { AppConfig } from "../config.js";
import { registerDiscordCommands } from "./commands.js";
import { handleMcpInteraction } from "../mcp/interactions.js";
import { getMcpPool } from "../flue/mcp.js";
import type { McpStore } from "../mcp/store.js";
import { handleSetupInteraction } from "../setup/interactions.js";
import type { SetupOrchestrator } from "../setup/orchestrator.js";
import type { SetupStore } from "../setup/store.js";
import { handleTaskInteraction } from "../task/interactions.js";
import type { TaskOrchestrator } from "../task/orchestrator.js";
import type { TaskThreadMessage } from "../task/orchestrator.js";
import type {
  ThreadMessageAttachment,
  ThreadMessageReplyQuote,
} from "../types.js";
import { clampDiscordContent } from "./limits.js";
import {
  parseCustomId,
  replyWithError,
  type UiNamespace,
} from "./ui/index.js";
import { summarizeError } from "../util/redact.js";

export function startDiscordGateway(
  token: string,
  config: AppConfig,
  orchestrator: TaskOrchestrator,
  setupStore: SetupStore,
  setupOrchestrator: SetupOrchestrator,
  mcpStore: McpStore,
): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`[threadcord] Discord ready as ${ready.user.tag}`);
    void registerDiscordCommands(client).catch((error) => {
      console.error("[threadcord] slash command registration failed", error);
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void routeMessage(message, orchestrator);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void routeInteraction(
      interaction,
      config,
      orchestrator,
      setupStore,
      setupOrchestrator,
      mcpStore,
    );
  });

  void client.login(token);
  return client;
}

export async function routeInteraction(
  interaction: Interaction,
  config: AppConfig,
  taskOrchestrator: TaskOrchestrator,
  setupStore: SetupStore,
  setupOrchestrator: SetupOrchestrator,
  mcpStore: McpStore,
): Promise<void> {
  const target = resolveInteractionTarget(interaction);
  if (!target) {
    console.warn(
      `[threadcord] unhandled interaction type=${interaction.type}`,
    );
    return;
  }
  if (target === "unknown") {
    console.warn(
      `[threadcord] unknown interaction route customId=${getCustomId(interaction) ?? "n/a"} command=${getCommandName(interaction) ?? "n/a"}`,
    );
    if (interaction.isRepliable()) {
      await replyWithError(interaction, "internal");
    }
    return;
  }

  try {
    if (target === "mcp") {
      await handleMcpInteraction({
        interaction,
        store: mcpStore,
        pool: getMcpPool(),
      });
      return;
    }
    if (target === "task") {
      await handleTaskInteraction({
        interaction,
        orchestrator: taskOrchestrator,
        setupStore,
        config,
      });
      return;
    }
    await handleSetupInteraction({
      interaction,
      store: setupStore,
      orchestrator: setupOrchestrator,
    });
  } catch (error) {
    console.error(
      `[threadcord] interaction handler failed (${target}):`,
      summarizeError(error),
    );
    if (interaction.isRepliable()) {
      await replyWithError(interaction, "internal");
    }
  }
}

type InteractionTarget = UiNamespace | "unknown";

function resolveInteractionTarget(
  interaction: Interaction,
): InteractionTarget | null {
  if (interaction.isChatInputCommand()) {
    const name = interaction.commandName;
    if (name === "task" || name === "setup" || name === "mcp") return name;
    return "unknown";
  }
  if (
    interaction.isButton() ||
    interaction.isModalSubmit() ||
    interaction.isStringSelectMenu()
  ) {
    const customId = interaction.customId;
    const parsed = parseCustomId(customId);
    return parsed?.ns ?? "unknown";
  }
  return null;
}

function getCustomId(interaction: Interaction): string | undefined {
  if (
    interaction.isButton() ||
    interaction.isModalSubmit() ||
    interaction.isStringSelectMenu()
  ) {
    return interaction.customId;
  }
  return undefined;
}

function getCommandName(interaction: Interaction): string | undefined {
  return interaction.isChatInputCommand()
    ? interaction.commandName
    : undefined;
}

async function routeMessage(
  message: Message,
  orchestrator: TaskOrchestrator,
): Promise<void> {
  if (message.partial) message = await message.fetch();
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  const replyQuote = await resolveReplyQuote(message);
  await orchestrator.handleThreadMessage(toThreadMessage(message, replyQuote));
}

/**
 * When the user used Discord's reply feature, fetch the referenced message and
 * return its content (clamped) plus whether the author was the bot, so the
 * agent can be given the context the user was replying to. Returns undefined
 * when the message was not a reply or the referenced message cannot be loaded.
 */
async function resolveReplyQuote(
  message: Message,
): Promise<ThreadMessageReplyQuote | undefined> {
  const referencedId = message.reference?.messageId;
  if (!referencedId) return undefined;
  let referenced: Message | undefined;
  try {
    referenced = await message.channel.messages.fetch(referencedId);
  } catch {
    return undefined;
  }
  if (!referenced) return undefined;
  const content = (referenced.content ?? "").trim();
  if (!content) return undefined;
  return {
    content: clampDiscordContent(content),
    authorBot: referenced.author?.bot ?? false,
  };
}

export function toThreadMessage(
  message: Message,
  replyQuote?: ThreadMessageReplyQuote,
): TaskThreadMessage {
  return {
    id: message.id,
    content: message.content,
    authorBot: message.author.bot,
    authorId: message.author.id,
    channelId: message.channelId,
    guildId: message.guildId,
    attachments: toAttachments(message),
    replyQuote,
    reply: async (content) => {
      await message.reply(clampDiscordContent(content));
    },
    replyView: async (payload) => {
      await message.reply(payload);
    },
    react: async (emoji) => {
      await message.react(emoji);
    },
    unreact: async (emoji) => {
      const me = message.client.user;
      if (me) await message.reactions.resolve(emoji)?.users.remove(me.id);
    },
  };
}

function toAttachments(message: Message): ThreadMessageAttachment[] | undefined {
  if (!message.attachments || message.attachments.size === 0) return undefined;
  const result: ThreadMessageAttachment[] = [];
  for (const attachment of message.attachments.values()) {
    result.push({
      url: attachment.url,
      name: attachment.name,
      contentType: attachment.contentType,
      width: attachment.width,
      height: attachment.height,
    });
  }
  return result;
}
