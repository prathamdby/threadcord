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
 * Polite opener words that small instruction-tuned models prepend to chat-style
 * replies. The namer prompt forbids these, but smaller models emit them anyway
 * (RLHF-trained preamble is encoded at the weight level, not at the
 * instruction-following layer), so we strip them defensively at the boundary.
 */
const THREAD_NAME_OPENER_WORDS =
  "(?:sure|here['’]s|here is|ok(?:ay)?|great|alright|absolutely|got it|certainly|of course|fine|perfect|alrighty)";

/**
 * Full preamble: an optional opener sequence followed by a real label
 * (article + optional adjective + optional "thread" + "name" or "title")
 * terminated by a hard separator. The label is required — without it, the
 * regex does not match, which protects titles that happen to start with an
 * opener word ("Sure thing: Create fix", "Great job on the PR", "Fine-tune
 * model parameters", "Sure: Fix login").
 *
 * The separator must be `:`, `.`, `—`, or `…` (any of these, with or without
 * preceding whitespace), or a hyphen preceded by whitespace. Requiring
 * whitespace before `-` protects hyphenated compounds ("name-list", "title-
 * bar", "fine-tune"). An earlier version used an optional separator and
 * silently truncated legitimate titles like "Title case formatter" -> "case
 * formatter" and "Thread name normalization service" -> "normalization
 * service".
 */
const THREAD_NAME_PREAMBLE = new RegExp(
  `^(?:${THREAD_NAME_OPENER_WORDS}[\\s,!?:;.…—\\-]+)*\\s*` +
    `(?:(?:a|an|the|my|your)\\s+)?` +
    `(?:good|great|perfect|better|final|concise)?\\s*` +
    `(?:thread\\s+)?(?:name|title)` +
    `(?:\\s*[:.—…]|\\s+[-])\\s*`,
  "i",
);

/**
 * A line that is nothing but a polite opener (one or more opener words,
 * separated by punctuation, with nothing else). Used to skip preamble-only
 * lines and try the next one. Each opener word must be followed by a
 * separator or end-of-string so legitimate English ("Sure thing: Create
 * fix") is not consumed.
 */
const THREAD_NAME_STANDALONE_OPENER = new RegExp(
  `^(?:${THREAD_NAME_OPENER_WORDS}(?:[\\s,!?:;.…—\\-]+|$))+\\s*$`,
  "i",
);

/**
 * Walk non-empty lines and return the first line that, after stripping a
 * leading polite-opener + label, still has content. Lines that are pure
 * opener ("Sure" alone, "OK." alone) are skipped so the next line is tried.
 * Returns "" if every line is preamble.
 */
export function stripThreadNamePreamble(raw: string): string {
  for (const rawLine of raw.split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (THREAD_NAME_STANDALONE_OPENER.test(line)) continue;
    const candidate = line.replace(THREAD_NAME_PREAMBLE, "").trim();
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
