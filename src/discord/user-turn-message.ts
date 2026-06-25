const pendingByInstance = new Map<string, string>();

export function setPendingUserTurnMessage(
  instanceId: string,
  message: string,
): void {
  const trimmed = message.trim();
  if (trimmed.length === 0) return;
  pendingByInstance.set(instanceId, trimmed);
}

export function takePendingUserTurnMessage(
  instanceId: string,
): string | undefined {
  const message = pendingByInstance.get(instanceId);
  pendingByInstance.delete(instanceId);
  return message;
}

export function clearPendingUserTurnMessage(instanceId: string): void {
  pendingByInstance.delete(instanceId);
}