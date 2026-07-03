import type { Message } from "discord.js";
import { clampDiscordContent } from "../discord/limits.js";
import type { ViewPayload } from "../discord/ui/index.js";
import type { ThreadRef } from "../types.js";

export interface TaskThreadRef extends ThreadRef {
  sendView(payload: ViewPayload): Promise<{ id: string }>;
  editView(messageId: string, payload: ViewPayload): Promise<void>;
}

export function isViewPayload(value: unknown): value is ViewPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "components" in value &&
    "flags" in value
  );
}

export function toTaskThreadRef(
  thread: Awaited<ReturnType<Message["startThread"]>>,
): TaskThreadRef {
  return {
    id: thread.id,
    send: async (content) => {
      const message = await thread.send(clampDiscordContent(content));
      return { id: message.id };
    },
    sendView: async (payload) => {
      const message = await thread.send(payload);
      return { id: message.id };
    },
    pin: async (messageId) => {
      const message = await thread.messages.fetch(messageId);
      await message.pin();
    },
    editMessage: async (messageId, content) => {
      await thread.messages.edit(messageId, clampDiscordContent(content));
    },
    editView: async (messageId, payload) => {
      await thread.messages.edit(messageId, payload);
    },
    sendTyping: async () => {
      await thread.sendTyping();
    },
    setName: async (name) => {
      await thread.setName(name);
    },
  };
}
