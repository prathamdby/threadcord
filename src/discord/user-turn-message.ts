const pendingByInstance = new Map<string, string[]>();

const QUEUE_CONFLICT_MESSAGE =
  "This turn already has a queued report. Combine into a single call.";

function assertQueueEmpty(instanceId: string): void {
  if (pendingByInstance.has(instanceId)) {
    throw new Error(QUEUE_CONFLICT_MESSAGE);
  }
}

export function queuePendingUserTurnMessages(
  instanceId: string,
  messages: string[],
): void {
  assertQueueEmpty(instanceId);
  const trimmed = messages.map((message) => message.trim()).filter(Boolean);
  if (trimmed.length === 0) {
    throw new Error("At least one non-empty message part is required.");
  }
  pendingByInstance.set(instanceId, trimmed);
}

export function setPendingUserTurnMessage(
  instanceId: string,
  message: string,
): void {
  const trimmed = message.trim();
  if (trimmed.length === 0) return;
  assertQueueEmpty(instanceId);
  pendingByInstance.set(instanceId, [trimmed]);
}

export function takePendingUserTurnMessages(instanceId: string): string[] {
  const messages = pendingByInstance.get(instanceId);
  pendingByInstance.delete(instanceId);
  return messages ?? [];
}

export function takePendingUserTurnMessage(
  instanceId: string,
): string | undefined {
  const messages = takePendingUserTurnMessages(instanceId);
  if (messages.length === 0) return undefined;
  return messages.join("\n\n");
}

export function clearPendingUserTurnMessage(instanceId: string): void {
  pendingByInstance.delete(instanceId);
}

export function hasPendingUserTurnMessages(instanceId: string): boolean {
  return pendingByInstance.has(instanceId);
}
