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
import { handleSetupInteraction } from "../setup/interactions.js";
import type { SetupOrchestrator } from "../setup/orchestrator.js";
import type { SetupStore } from "../setup/store.js";
import { handleTaskInteraction } from "../task/interactions.js";
import type { TaskOrchestrator } from "../task/orchestrator.js";
import { clampDiscordContent } from "./limits.js";
import type { ThreadMessage } from "../types.js";

export function startDiscordGateway(
  token: string,
  config: AppConfig,
  orchestrator: TaskOrchestrator,
  setupStore: SetupStore,
  setupOrchestrator: SetupOrchestrator,
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
    );
  });

  void client.login(token);
  return client;
}

async function routeInteraction(
  interaction: Interaction,
  config: AppConfig,
  taskOrchestrator: TaskOrchestrator,
  setupStore: SetupStore,
  setupOrchestrator: SetupOrchestrator,
): Promise<void> {
  if (
    await handleTaskInteraction({
      interaction,
      orchestrator: taskOrchestrator,
      setupStore,
      config,
    })
  ) {
    return;
  }
  await handleSetupInteraction({
    interaction,
    store: setupStore,
    orchestrator: setupOrchestrator,
  });
}

async function routeMessage(
  message: Message,
  orchestrator: TaskOrchestrator,
): Promise<void> {
  if (message.partial) message = await message.fetch();
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;
  await orchestrator.handleThreadMessage(toThreadMessage(message));
}

function toThreadMessage(message: Message): ThreadMessage {
  return {
    id: message.id,
    content: message.content,
    authorBot: message.author.bot,
    channelId: message.channelId,
    reply: async (content) => {
      await message.reply(clampDiscordContent(content));
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