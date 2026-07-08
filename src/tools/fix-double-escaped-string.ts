/**
 * Best-effort fix for double-escaped strings (literal \n, \t, etc.) that
 * weaker models sometimes emit inside JSON string fields.
 *
 * Conservative: whole double-quoted JSON string blobs may parse; manual
 * unescape skips Windows/UNC path-like content so sequences like C:\new\folder
 * are not rewritten as newlines. Single-quoted wrapping is not valid JSON and
 * falls through to the regex-based unescape path.
 */
export function fixDoubleEscapedString(value: string): {
  text: string;
  fixed: boolean;
} {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string" && parsed !== value) {
        return { text: parsed, fixed: true };
      }
    } catch {
      // manual unescape below
    }
  }

  if (looksLikeFilesystemPath(value)) {
    return { text: value, fixed: false };
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

/** Drive-letter paths, UNC shares, or clear path segments with backslashes. */
function looksLikeFilesystemPath(value: string): boolean {
  if (/^[A-Za-z]:\\/.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  // e.g. "... C:\new\folder ..." or path-only fragments with backslash dirs
  if (/(?:^|[\s"'`=(])[A-Za-z]:\\[^\s"'`]+/.test(value)) return true;
  return false;
}
