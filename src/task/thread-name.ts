/** Logical Discord thread title before an LLM-readable rename. */
export function threadName(repo: string, taskId: string): string {
  return `threadcord-${repo.replace("/", "-")}-${taskId.slice(0, 8)}`.slice(
    0,
    90,
  );
}

/** User-facing task text from a dispatched turn prompt (after metadata blocks). */
export function extractTaskInstruction(prompt: string): string {
  const marker = "\n\nSetup profile memory:";
  const idx = prompt.indexOf(marker);
  if (idx === -1) return prompt.trim();
  const afterMarker = prompt.slice(idx + marker.length).replace(/^\n+/, "");
  const sep = afterMarker.lastIndexOf("\n\n");
  if (sep === -1) return prompt.trim();
  const instruction = afterMarker.slice(sep + 2).trim();
  return instruction || prompt.trim();
}

const DISCORD_THREAD_NAME_MAX = 100;

/** Clamp and normalize a generated title for Discord thread `name`. */
export function sanitizeDiscordThreadName(raw: string): string {
  const collapsed = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stripped = collapsed.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!stripped) return "threadcord task";
  return stripped.slice(0, DISCORD_THREAD_NAME_MAX);
}