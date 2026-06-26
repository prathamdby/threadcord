import { posix } from "node:path";

const { basename, isAbsolute, relative, resolve } = posix;

const PATH_PRIMARY_TOOLS = new Set([
  "read_file",
  "read",
  "write_file",
  "write",
  "edit_file",
  "edit",
  "str_replace",
  "patch",
]);

/** Tools whose Discord preview shows a filesystem path from tool args. */
export function toolPreviewUsesPath(toolName: string): boolean {
  return PATH_PRIMARY_TOOLS.has(toolName);
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Strip workspace / container prefixes so Discord shows a short repo-relative path.
 */
export function shortenPathForPreview(raw: string, repoRoot?: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  if (repoRoot) {
    const absRoot = resolve(toPosix(repoRoot));
    const posixPath = toPosix(trimmed);
    const absPath = isAbsolute(posixPath)
      ? resolve(posixPath)
      : resolve(absRoot, posixPath);
    const rel = relative(absRoot, absPath);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      const relPosix = toPosix(rel);
      return relPosix.length > 0 ? relPosix : ".";
    }
  }

  const posixPath = toPosix(trimmed);
  const withLeading = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  const workspaceTail = workspaceRepoRelative(withLeading);
  if (workspaceTail !== undefined) {
    return workspaceTail;
  }

  return posixPath.startsWith("/") ? posixPath.slice(1) : posixPath;
}

/** Replace absolute workspace paths embedded in shell commands or other text. */
export function shortenWorkspacePathsInText(
  text: string,
  repoRoot?: string,
): string {
  const workspacePath =
    /\/(?:workspaces\/[^/\s'"`]+(?:\/[^/\s'"`]+)+|root\/workspace\/[^\s'"`;|&]+)/g;
  return text.replace(workspacePath, (match) =>
    shortenPathForPreview(match, repoRoot),
  );
}

function looksLikeFilesystemPath(value: string): boolean {
  if (value.length > 1024 || value.includes("\n")) {
    return false;
  }
  const p = toPosix(value.trim());
  return p.startsWith("/") && p.includes("/", 1);
}

/** Shorten when the primary arg is missing but the first string field is a path. */
export function shortenPreviewString(
  value: string,
  toolName: string,
  repoRoot?: string,
): string {
  if (toolPreviewUsesPath(toolName)) {
    return shortenPathForPreview(value, repoRoot);
  }
  if (looksLikeFilesystemPath(value)) {
    return shortenPathForPreview(value, repoRoot);
  }
  return value;
}

function workspaceRepoRelative(absolutePosix: string): string | undefined {
  const workspaces = absolutePosix.match(/^\/workspaces\/[^/]+\/[^/]+\/?(.*)$/);
  if (workspaces) {
    const tail = workspaces[1] ?? "";
    return tail.length > 0 ? tail : basename(absolutePosix);
  }

  if (absolutePosix.startsWith("/root/workspace/")) {
    const tail = tailAfterRepoMarkers(
      absolutePosix.slice("/root/workspace/".length),
    );
    if (tail !== undefined) {
      return tail;
    }
  }

  return undefined;
}

const REPO_PATH_MARKERS = new Set([
  "src",
  "test",
  "lib",
  "app",
  "packages",
  "dist",
  "scripts",
]);

function tailAfterRepoMarkers(pathAfterWorkspace: string): string | undefined {
  const segments = pathAfterWorkspace.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  for (let i = 0; i < segments.length; i += 1) {
    if (REPO_PATH_MARKERS.has(segments[i]!)) {
      return segments.slice(i).join("/");
    }
  }
  return undefined;
}
