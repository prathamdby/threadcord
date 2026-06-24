export const DISCORD_MESSAGE_CONTENT_LIMIT = 2000;

function truncationMarker(removedCount: number): string {
  return `\n...[truncated ${removedCount} chars]...\n`;
}

export function clampDiscordContent(
  content: string,
  maxLength = DISCORD_MESSAGE_CONTENT_LIMIT,
): string {
  if (maxLength <= 0) return "";
  if (content.length <= maxLength) return content;

  const minMarker = truncationMarker(0);
  if (maxLength <= minMarker.length) {
    return content.slice(0, maxLength);
  }

  let textBudget = maxLength - minMarker.length;
  let headLen = Math.ceil(textBudget / 2);
  let tailLen = textBudget - headLen;

  for (let pass = 0; pass < 8; pass++) {
    const removed = content.length - headLen - tailLen;
    if (removed <= 0) {
      return content.slice(0, maxLength);
    }
    const marker = truncationMarker(removed);
    textBudget = maxLength - marker.length;
    if (textBudget <= 0) {
      return content.slice(0, maxLength);
    }
    headLen = Math.ceil(textBudget / 2);
    tailLen = textBudget - headLen;
    const head = content.slice(0, headLen);
    const tail = content.slice(content.length - tailLen);
    const result =
      head + truncationMarker(content.length - headLen - tailLen) + tail;
    if (result.length <= maxLength) {
      return result;
    }
  }

  return content.slice(0, maxLength);
}
