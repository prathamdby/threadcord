export const DISCORD_THREAD_INSTANCE_PREFIX = "discord:thread:" as const;

export function toAgentInstanceId(threadId: string): string {
  return `${DISCORD_THREAD_INSTANCE_PREFIX}${threadId}`;
}

export function isThreadcordInstance(instanceId: string): boolean {
  return instanceId.startsWith(DISCORD_THREAD_INSTANCE_PREFIX);
}

export function parseDiscordThreadId(instanceId: string): string | undefined {
  if (!isThreadcordInstance(instanceId)) return undefined;
  return instanceId.slice(DISCORD_THREAD_INSTANCE_PREFIX.length);
}

export function pendingThreadId(taskId: string): string {
  return `pending:${taskId}`;
}

export function isPendingThreadId(threadId: string): boolean {
  return threadId.startsWith("pending:");
}
