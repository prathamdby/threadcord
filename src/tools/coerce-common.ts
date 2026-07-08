const ENVELOPE_KEYS = ["payload", "data", "result", "args"] as const;

export function unwrapEnvelope(
  raw: Record<string, unknown>,
  keys: readonly string[] = ENVELOPE_KEYS,
): { value: Record<string, unknown>; label?: string } {
  for (const key of keys) {
    if (!(key in raw)) continue;
    const inner = raw[key];
    if (
      inner !== null &&
      typeof inner === "object" &&
      !Array.isArray(inner)
    ) {
      return {
        value: { ...(inner as Record<string, unknown>) },
        label: `unwrap_${key}`,
      };
    }
  }
  return { value: raw };
}

/**
 * For each [from, to], if `to` is missing and `from` is present, copy and delete `from`.
 * Prefer canonical: never overwrite an existing `to`.
 */
export function aliasKeys(
  obj: Record<string, unknown>,
  map: ReadonlyArray<readonly [string, string]>,
): string[] {
  const labels: string[] = [];
  for (const [from, to] of map) {
    if (Object.prototype.hasOwnProperty.call(obj, to)) continue;
    if (!Object.prototype.hasOwnProperty.call(obj, from)) continue;
    obj[to] = obj[from];
    delete obj[from];
    labels.push(`alias_${from}_to_${to}`);
  }
  return labels;
}

/** Digit string → int; already int → pass; else undefined. */
export function coercePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number.parseInt(value, 10);
    if (n >= 1) return n;
  }
  return undefined;
}

/** Only if entire trimmed string is one fenced block. */
export function stripWholeStringCodeFence(s: string): {
  text: string;
  stripped: boolean;
} {
  const trimmed = s.trim();
  const match = trimmed.match(
    /^```(?:[a-zA-Z0-9_+-]*)?\r?\n([\s\S]*?)\r?\n```$/,
  );
  if (!match) {
    return { text: s, stripped: false };
  }
  return { text: match[1] ?? "", stripped: true };
}

export function trimString(s: string): { text: string; trimmed: boolean } {
  const text = s.trim();
  return { text, trimmed: text !== s };
}
