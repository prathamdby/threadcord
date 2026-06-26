import { ThreadAutoArchiveDuration, type Message } from "discord.js";
import { clampDiscordContent } from "../discord/limits.js";
import type { ThreadRef } from "../types.js";
import type { SetupStore } from "./store.js";

export function setupThreadName(repo: string, runId: string): string {
  return `setup-${repo.replace("/", "-")}-${runId.slice(0, 8)}`.slice(0, 100);
}

export function toSetupThreadRef(
  thread: Awaited<ReturnType<Message["startThread"]>>,
): ThreadRef {
  return {
    id: thread.id,
    send: async (content) => {
      const message = await thread.send(clampDiscordContent(content));
      return { id: message.id };
    },
    editMessage: async (messageId, content) => {
      await thread.messages.edit(messageId, clampDiscordContent(content));
    },
    sendTyping: async () => {
      await thread.sendTyping();
    },
    setName: async (name) => {
      await thread.setName(name);
    },
  };
}

export async function openSetupRunThread(input: {
  anchorMessage: Message;
  store: SetupStore;
  runId: string;
  repo: string;
  branch: string;
  model: string;
  actionLabel: "create" | "update";
}): Promise<ThreadRef | undefined> {
  const message = input.anchorMessage;

  const thread = await message.startThread({
    name: setupThreadName(input.repo, input.runId),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  });
  const threadRef = toSetupThreadRef(thread);
  const header = [
    `Setup ${input.actionLabel} for ${input.repo} on ${input.branch}`,
    `Run: ${input.runId}`,
    `Model: ${input.model}`,
  ].join("\n");
  await threadRef.send(header);
  const progress = await threadRef.send("Starting setup agent…");
  const attached = await input.store.attachDiscordThread(
    input.runId,
    thread.id,
    progress.id,
  );
  if (!attached) {
    await thread.send(
      "Could not attach this thread to the setup run (run may have already finished).",
    );
    return undefined;
  }
  return threadRef;
}
