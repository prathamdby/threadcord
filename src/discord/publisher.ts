import type { Client } from "discord.js";
import { redact } from "../util/redact.js";

export class DiscordPublisher {
  constructor(private readonly client: Client) {}

  async send(threadId: string, content: string): Promise<{ id: string }> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isSendable())
      throw new Error(`Discord thread ${threadId} is not sendable`);
    return channel.send(redact(content));
  }

  async edit(
    threadId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isTextBased())
      throw new Error(`Discord thread ${threadId} is not text based`);
    const message = await channel.messages.fetch(messageId);
    await message.edit(redact(content));
  }
}
