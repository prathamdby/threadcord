import type { RankedFile, RepoMapResult } from "./types.js";

const DEFAULT_MAX_CHARS = 12_000;
const MAX_DEFS_PER_FILE = 24;

/**
 * Fit the highest-ranked files/defs into a character budget.
 * Linear scan accumulates file blocks until the budget is exhausted.
 */
export function renderRepoMap(
  ranked: RankedFile[],
  options: {
    maxChars?: number;
    filesScanned: number;
    warnings?: string[];
  },
): RepoMapResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const warnings = options.warnings ?? [];
  if (ranked.length === 0) {
    return {
      map: "(no source symbols found)",
      filesScanned: options.filesScanned,
      filesMapped: 0,
      defsShown: 0,
      truncated: options.filesScanned > 0,
      warnings,
    };
  }

  const blocks: string[] = [];
  let defsShown = 0;
  let filesMapped = 0;
  let bodyLen = 0;
  let hardTrimmed = false;

  for (const file of ranked) {
    const block = formatFileBlock(file);
    const extra = (blocks.length > 0 ? 1 : 0) + block.text.length;
    if (bodyLen + extra > maxChars && filesMapped > 0) {
      break;
    }
    if (bodyLen + extra > maxChars && filesMapped === 0) {
      // Even the top file exceeds the budget — hard-trim it.
      const trimmed =
        block.text.slice(0, Math.max(0, maxChars - 20)) + "\n… (trimmed)";
      blocks.push(trimmed);
      defsShown = block.defsShown;
      filesMapped = 1;
      hardTrimmed = true;
      break;
    }
    blocks.push(block.text);
    bodyLen += extra;
    defsShown += block.defsShown;
    filesMapped += 1;
  }

  const bodyText = blocks.join("\n");
  const truncated = filesMapped < ranked.length || hardTrimmed;
  const header = [
    `Repository map (${defsShown} defs from ${filesMapped} of ${options.filesScanned} files)`,
    truncated
      ? "Map truncated to token budget — use path/focusFiles to narrow."
      : null,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    map: header + bodyText,
    filesScanned: options.filesScanned,
    filesMapped,
    defsShown,
    truncated,
    warnings,
  };
}

function formatFileBlock(
  file: RankedFile,
): { text: string; defsShown: number } {
  const parts: string[] = [file.relPath];
  const defs = file.defs.slice(0, MAX_DEFS_PER_FILE);
  if (defs.length === 0) {
    parts.push("  (no definitions)");
    return { text: parts.join("\n"), defsShown: 0 };
  }
  for (const d of defs) {
    const sig = d.signature || `${d.category} ${d.name}`;
    parts.push(`  L${d.line} ${sig}`);
  }
  if (file.defs.length > MAX_DEFS_PER_FILE) {
    parts.push(`  … +${file.defs.length - MAX_DEFS_PER_FILE} more`);
  }
  return { text: parts.join("\n"), defsShown: defs.length };
}
