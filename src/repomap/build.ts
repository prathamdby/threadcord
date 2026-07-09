import { resolve } from "node:path";
import { discoverSourceFiles } from "./discover.js";
import { extractTags, toRelPath } from "./parser.js";
import { rankFiles } from "./rank.js";
import { renderRepoMap } from "./render.js";
import type { RepoMapOptions, RepoMapResult, Tag } from "./types.js";

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_FILE_BYTES = 256_000;

/**
 * Build a ranked, token-budgeted repository map for `options.root`.
 * Pure function over the filesystem — safe to call from a tool or tests.
 */
export async function buildRepoMap(
  options: RepoMapOptions,
): Promise<RepoMapResult> {
  const root = resolve(options.root);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const files = discoverSourceFiles(root, {
    ...(options.path ? { path: options.path } : {}),
    maxFiles,
    maxFileBytes,
  });

  const focusFiles = new Set(
    (options.focusFiles ?? []).map((p) => toRelPath(root, p)).filter(Boolean),
  );
  const priorityIdents = new Set(
    (options.priorityIdents ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  const allTags: Tag[] = [];
  for (const file of files) {
    try {
      const tags = await extractTags(file.absPath, file.relPath, file.grammar);
      allTags.push(...tags);
    } catch (error) {
      console.warn(
        `[threadcord] repo_map skip ${file.relPath}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const ranked = rankFiles({
    tags: allTags,
    focusFiles,
    priorityIdents,
  });

  return renderRepoMap(ranked, {
    maxChars,
    filesScanned: files.length,
  });
}
