const ENVELOPE_KEYS = ["payload", "data", "result", "args"] as const;

export { ENVELOPE_KEYS };

/**
 * Unwrap a model envelope only when safe:
 * - sole top-level key is an envelope key whose value is a non-array object, or
 * - `preserveIfKeysPresent` is set and none of those keys exist at the top level
 *   (so nested-only args can unwrap even with junk siblings).
 * Never unwrap when a preserved canonical key is already present alongside an envelope.
 */
export function unwrapEnvelope(
  raw: Record<string, unknown>,
  keys: readonly string[] | undefined = ENVELOPE_KEYS,
  options?: { preserveIfKeysPresent?: readonly string[] },
): { value: Record<string, unknown>; label?: string } {
  const topKeys = Object.keys(raw);
  const preserve = options?.preserveIfKeysPresent;
  const keyList = keys ?? ENVELOPE_KEYS;

  for (const key of keyList) {
    if (!(key in raw)) continue;
    const inner = raw[key];
    if (
      inner === null ||
      typeof inner !== "object" ||
      Array.isArray(inner)
    ) {
      continue;
    }

    const soleKey = topKeys.length === 1 && topKeys[0] === key;
    const noPreserved =
      preserve !== undefined &&
      preserve.every(
        (k) => !Object.prototype.hasOwnProperty.call(raw, k),
      );

    if (!soleKey && !noPreserved) continue;

    return {
      value: { ...(inner as Record<string, unknown>) },
      label: `unwrap_${key}`,
    };
  }
  return { value: raw };
}

/**
 * For each [from, to], if `to` is missing and `from` is present, copy and delete `from`.
 * Prefer canonical: never overwrite an existing `to`, but still delete the alias key.
 */
export function aliasKeys(
  obj: Record<string, unknown>,
  map: ReadonlyArray<readonly [string, string]>,
): string[] {
  const labels: string[] = [];
  for (const [from, to] of map) {
    if (Object.prototype.hasOwnProperty.call(obj, to)) {
      if (Object.prototype.hasOwnProperty.call(obj, from)) {
        delete obj[from];
      }
      continue;
    }
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
