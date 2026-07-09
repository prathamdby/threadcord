import type { RankedFile, RepoMapResult } from "./types.js";

const DEFAULT_MAX_CHARS = 12_000;
const MAX_DEFS_PER_FILE = 24;

/**
 * Fit the highest-ranked files/defs into a character budget.
 * Binary-search the number of files so the rendered map stays near maxChars.
 */
export function renderRepoMap(
  ranked: RankedFile[],
  options: {
    maxChars?: number;
    filesScanned: number;
  },
): RepoMapResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (ranked.length === 0) {
    return {
      map: "(no source symbols found)",
      filesScanned: options.filesScanned,
      filesMapped: 0,
      defsShown: 0,
      truncated: options.filesScanned > 0,
    };
  }

  let lo = 1;
  let hi = ranked.length;
  let best = 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rendered = formatFiles(ranked.slice(0, mid));
    if (rendered.text.length <= maxChars) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let body = formatFiles(ranked.slice(0, best));
  if (body.text.length > maxChars) {
    body = {
      text: body.text.slice(0, maxChars - 20) + "\n… (trimmed)",
      defsShown: body.defsShown,
    };
  }

  const truncated =
    best < ranked.length || body.text.includes("… (trimmed)");
  const header = [
    `Repository map (${body.defsShown} defs from ${best} of ${options.filesScanned} files)`,
    truncated ? "Map truncated to token budget — use path/focusFiles to narrow." : null,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    map: header + body.text,
    filesScanned: options.filesScanned,
    filesMapped: best,
    defsShown: body.defsShown,
    truncated,
  };
}

function formatFiles(
  files: RankedFile[],
): { text: string; defsShown: number } {
  const parts: string[] = [];
  let defsShown = 0;
  for (const file of files) {
    parts.push(file.relPath);
    const defs = file.defs.slice(0, MAX_DEFS_PER_FILE);
    if (defs.length === 0) {
      parts.push("  (no definitions)");
      continue;
    }
    for (const d of defs) {
      const sig = d.signature || `${d.category} ${d.name}`;
      parts.push(`  L${d.line} ${sig}`);
      defsShown += 1;
    }
    if (file.defs.length > MAX_DEFS_PER_FILE) {
      parts.push(`  … +${file.defs.length - MAX_DEFS_PER_FILE} more`);
    }
  }
  return { text: parts.join("\n"), defsShown };
}
