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

/**
 * Polite-opener words that small instruction-tuned models prepend to chat-style
 * replies. The namer prompt forbids these, but smaller models emit them anyway
 * (RLHF-trained preamble is encoded at the weight level, not the
 * instruction-following level), so we strip them defensively at the boundary.
 * Each match must be followed by a separator or end-of-string, so legitimate
 * title tokens like "OKR" or "Alaska" are not damaged.
 */
const THREAD_NAME_OPENER =
  /^(?:(?:sure|here['’]s|here is|ok(?:ay)?|great|alright|absolutely|got it|certainly|of course|fine|perfect|alrighty)[\s,!?:;.…—\-]+)+\s*/i;

/**
 * Leading label a model might prepend even after stripping the opener, e.g.
 * "Sure, here's the name: Fix login" -> "the name: " is removed by this.
 */
const THREAD_NAME_LABEL =
  /^(?:(?:a|an|the|my|your)\s+)?(?:good|great|perfect|better|final|concise)?\s*(?:thread\s+)?(?:name|title)\s*[:.,\-—…]?\s*/i;

/**
 * Walk non-empty lines and return the first line that, after stripping a
 * leading polite opener and a leading label, still has content. Returns "" if
 * every line is preamble.
 */
export function stripThreadNamePreamble(raw: string): string {
  for (const rawLine of raw.split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const candidate = line
      .replace(THREAD_NAME_OPENER, "")
      .replace(THREAD_NAME_LABEL, "")
      .trim();
    if (candidate) return candidate;
  }
  return "";
}

/** Clamp and normalize a generated title for Discord thread `name`. */
export function sanitizeDiscordThreadName(raw: string): string {
  const preambled = stripThreadNamePreamble(raw);
  if (!preambled) {
    // The pre-cleaner consumed the entire input as preamble, so the title is
    // effectively missing. Fall back to the default rather than ship the raw
    // preamble to Discord.
    return "threadcord task";
  }
  const collapsed = preambled
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stripped = collapsed.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!stripped) return "threadcord task";
  return stripped.slice(0, DISCORD_THREAD_NAME_MAX);
}
