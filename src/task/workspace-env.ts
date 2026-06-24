import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface WorkspacePaths {
  home: string;
  npmPrefix: string;
  npmBin: string;
  cache: string;
}

export function workspacePaths(workspaceRoot: string): WorkspacePaths {
  const npmPrefix = join(workspaceRoot, ".npm-global");
  return {
    home: join(workspaceRoot, ".home"),
    npmPrefix,
    npmBin: join(npmPrefix, "bin"),
    cache: join(workspaceRoot, ".cache"),
  };
}

export function discoverHomeBinDirs(home: string): string[] {
  const dirs = [join(home, "bin"), join(home, ".local", "bin")];
  if (!existsSync(home)) {
    return dirs;
  }
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.push(join(home, entry.name, "bin"));
      }
    }
  } catch {
    // HOME may be unreadable during early bootstrap.
  }
  return [...new Set(dirs)];
}

export function workspacePathPrefix(workspaceRoot: string): string {
  const paths = workspacePaths(workspaceRoot);
  return [...new Set([paths.npmBin, ...discoverHomeBinDirs(paths.home)])].join(
    ":",
  );
}

export function workspaceEnv(
  workspaceRoot: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const paths = workspacePaths(workspaceRoot);
  const inheritedPath = process.env.PATH;
  const prefix = workspacePathPrefix(workspaceRoot);
  return {
    PATH: inheritedPath ? `${prefix}:${inheritedPath}` : prefix,
    HOME: paths.home,
    NPM_CONFIG_PREFIX: paths.npmPrefix,
    THREADCORD_WORKSPACE_BIN: paths.npmBin,
    XDG_CACHE_HOME: paths.cache,
    ...extra,
  };
}

export function wrapWorkspaceBashCommand(command: string): string {
  return [
    "__threadcord_refresh_home_path() {",
    "  local prefix=\"${THREADCORD_WORKSPACE_BIN:-}\" rest=\"$PATH\" additions=\"\" bin",
    "  if [[ -n \"$prefix\" && \"$PATH\" == \"$prefix\"* ]]; then",
    "    rest=\"${PATH#${prefix}:}\"",
    "  fi",
    "  while IFS= read -r bin; do",
    "    [[ -z \"$bin\" || \":$PATH:\" == *\":$bin:\"* ]] && continue",
    "    additions=\"${additions:+$additions:}$bin\"",
    "  done < <(printf '%s\\n' \"$HOME/bin\" \"$HOME/.local/bin\"; find \"$HOME\" -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null | sort -u)",
    "  if [[ -n \"$additions\" ]]; then",
    "    if [[ -n \"$prefix\" ]]; then",
    "      export PATH=\"$prefix:$additions${rest:+:$rest}\"",
    "    else",
    "      export PATH=\"$additions${rest:+:$rest}\"",
    "    fi",
    "  fi",
    "}",
    "trap '__threadcord_refresh_home_path' DEBUG",
    "__threadcord_refresh_home_path",
    command,
  ].join("\n");
}

export async function ensureWorkspaceDirs(workspaceRoot: string): Promise<void> {
  const paths = workspacePaths(workspaceRoot);
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.npmPrefix, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
  ]);
}
