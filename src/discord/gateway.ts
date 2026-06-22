import { Client, Events, GatewayIntentBits, Partials, ThreadAutoArchiveDuration, type Message } from 'discord.js';
import type { TaskOrchestrator } from '../task/orchestrator.js';
import type { ChannelMessage, ThreadMessage, ThreadRef } from '../types.js';

export function startDiscordGateway(token: string, orchestrator: TaskOrchestrator): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message]
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`[threadcord] Discord ready as ${ready.user.tag}`);
  });

  client.on(Events.MessageCreate, (message) => {
    void routeMessage(message, orchestrator);
  });

  void client.login(token);
  return client;
}

async function routeMessage(message: Message, orchestrator: TaskOrchestrator): Promise<void> {
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
    createThread: async (name) => toThreadRef(await message.startThread({
      name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek
    })),
    reply: async (content) => {
      await message.reply(content);
    }
  };
}

function toThreadMessage(message: Message): ThreadMessage {
  return {
    id: message.id,
    content: message.content,
    authorBot: message.author.bot,
    channelId: message.channelId,
    reply: async (content) => {
      await message.reply(content);
    }
  };
}

function toThreadRef(thread: Awaited<ReturnType<Message['startThread']>>): ThreadRef {
  return {
    id: thread.id,
    send: async (content) => {
      const message = await thread.send(content);
      return { id: message.id };
    },
    editMessage: async (messageId, content) => {
      const message = await thread.messages.fetch(messageId);
      await message.edit(content);
    }
  };
}
