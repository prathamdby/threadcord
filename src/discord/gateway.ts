import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  ThreadAutoArchiveDuration,
  type Message,
} from "discord.js";
import {
  handleSetupInteraction,
  registerSetupCommands,
} from "../setup/interactions.js";
import type { SetupOrchestrator } from "../setup/orchestrator.js";
import type { SetupStore } from "../setup/store.js";
import type { TaskOrchestrator } from "../task/orchestrator.js";
import { clampDiscordContent } from "./limits.js";
import type { ChannelMessage, ThreadMessage, ThreadRef } from "../types.js";

export function startDiscordGateway(
  token: string,
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
    void registerSetupCommands(client).catch((error) => {
      console.error("[threadcord] setup command registration failed", error);
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void routeMessage(message, orchestrator);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void routeInteraction(interaction, setupStore, setupOrchestrator);
  });

  void client.login(token);
  return client;
}

async function routeInteraction(
  interaction: Interaction,
  setupStore: SetupStore,
  setupOrchestrator: SetupOrchestrator,
): Promise<void> {
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

  if (message.channel.isThread()) {
    await orchestrator.handleThreadMessage(toThreadMessage(message));
    return;
  }
  await orchestrator.handleChannelMessage(toChannelMessage(message));
}

function toChannelMessage(message: Message): ChannelMessage {
  return {
    id: message.id,
    content: message.content,
    authorBot: message.author.bot,
    channelId: message.channelId,
    createThread: async (name) =>
      toThreadRef(
        await message.startThread({
          name,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        }),
      ),
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

function toThreadRef(
  thread: Awaited<ReturnType<Message["startThread"]>>,
): ThreadRef {
  return {
    id: thread.id,
    send: async (content) => {
      const message = await thread.send(clampDiscordContent(content));
      return { id: message.id };
    },
    editMessage: async (messageId, content) => {
      const message = await thread.messages.fetch(messageId);
      await message.edit(clampDiscordContent(content));
    },
    sendTyping: async () => {
      await thread.sendTyping();
    },
    setName: async (name) => {
      await thread.setName(name);
    },
  };
}
