/**
 * Best-effort fix for double-escaped strings (literal \n, \t, etc.) that
 * weaker models sometimes emit inside JSON string fields.
 */
export function fixDoubleEscapedString(value: string): {
  text: string;
  fixed: boolean;
} {
  // Whole value is a JSON-encoded string (quoted).
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    try {
      const parsed = JSON.parse(
        value.startsWith("'")
          ? `"${value.slice(1, -1).replace(/"/g, '\\"')}"`
          : value,
      );
      if (typeof parsed === "string" && parsed !== value) {
        return { text: parsed, fixed: true };
      }
    } catch {
      // fall through to manual unescape
    }
  }

  if (!/\\[nrt"'\\]/.test(value)) {
    return { text: value, fixed: false };
  }

  let fixed = false;
  const text = value.replace(/\\([nrt"'\\])/g, (_match, ch: string) => {
    fixed = true;
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "'":
        return "'";
      case "\\":
        return "\\";
      default:
        return ch;
    }
  });
  return { text, fixed };
}
