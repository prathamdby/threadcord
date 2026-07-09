import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  GRAMMAR_SPECS,
  SKIP_DIR_NAMES,
  grammarForPath,
  shouldSkipFile,
  type GrammarId,
} from "./languages.js";

export interface DiscoveredFile {
  absPath: string;
  relPath: string;
  grammar: GrammarId;
  size: number;
}

/**
 * Walk `root` (optionally scoped to `subpath`) and collect source files with a
 * known grammar. Honors skip-dir names and basic binary/generated filters.
 * Caps at `maxFiles` (first-seen order is depth-first; ranking happens later).
 */
export function discoverSourceFiles(
  root: string,
  options: {
    path?: string;
    maxFiles?: number;
    maxFileBytes?: number;
  } = {},
): DiscoveredFile[] {
  const absRoot = resolve(root);
  const maxFiles = options.maxFiles ?? 400;
  const maxFileBytes = options.maxFileBytes ?? 256_000;
  const start = options.path
    ? resolve(absRoot, options.path)
    : absRoot;

  if (start !== absRoot && !start.startsWith(absRoot + sep)) {
    throw new Error(
      `path must stay within the repository root (got ${options.path}).`,
    );
  }

  const out: DiscoveredFile[] = [];

  function walk(dir: string): void {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        if (name.startsWith(".") && name !== ".") continue;
        walk(join(dir, name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFile(name)) continue;
      const grammar = grammarForPath(name);
      if (!grammar || !GRAMMAR_SPECS[grammar]) continue;
      const absPath = join(dir, name);
      let size = 0;
      try {
        size = statSync(absPath).size;
      } catch {
        continue;
      }
      if (size <= 0 || size > maxFileBytes) continue;
      const relPath = relative(absRoot, absPath).split(sep).join("/");
      out.push({ absPath, relPath, grammar, size });
    }
  }

  let startStat;
  try {
    startStat = statSync(start);
  } catch {
    throw new Error(`path does not exist: ${options.path ?? "."}`);
  }

  if (startStat.isFile()) {
    const name = start.split(sep).pop() ?? start;
    const grammar = grammarForPath(name);
    if (!grammar) {
      throw new Error(
        `Unsupported file type for repo map: ${options.path ?? name}`,
      );
    }
    if (startStat.size > 0 && startStat.size <= maxFileBytes) {
      out.push({
        absPath: start,
        relPath: relative(absRoot, start).split(sep).join("/"),
        grammar,
        size: startStat.size,
      });
    }
    return out;
  }

  walk(start);
  return out;
}
