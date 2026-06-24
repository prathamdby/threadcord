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

export function workspaceEnv(
  workspaceRoot: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const paths = workspacePaths(workspaceRoot);
  return {
    PATH: `${paths.npmBin}:${process.env.PATH ?? ""}`,
    HOME: paths.home,
    NPM_CONFIG_PREFIX: paths.npmPrefix,
    XDG_CACHE_HOME: paths.cache,
    ...extra,
  };
}

export async function ensureWorkspaceDirs(workspaceRoot: string): Promise<void> {
  const paths = workspacePaths(workspaceRoot);
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.npmPrefix, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
  ]);
}
