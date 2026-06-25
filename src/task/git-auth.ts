import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceEnv } from "./workspace-env.js";

const WORKSPACE_ASKPASS_DIR = ".git-askpass";
const WORKSPACE_ASKPASS_SCRIPT = "askpass.sh";

export function githubHttpsCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

export async function writeGitAskPass(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      '  *) printf "%s\\n" "$GITHUB_TOKEN" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
}

export function workspaceGitAskPassPath(workspaceRoot: string): string {
  return join(workspaceRoot, WORKSPACE_ASKPASS_DIR, WORKSPACE_ASKPASS_SCRIPT);
}

/** Writes a persistent askpass script under the workspace for long-lived sandboxes. */
export async function prepareWorkspaceGitAuth(
  workspaceRoot: string,
): Promise<string> {
  const dir = join(workspaceRoot, WORKSPACE_ASKPASS_DIR);
  await mkdir(dir, { recursive: true });
  const askPassPath = join(dir, WORKSPACE_ASKPASS_SCRIPT);
  try {
    await stat(askPassPath);
  } catch {
    await writeGitAskPass(askPassPath);
  }
  return askPassPath;
}

export function githubHttpsGitEnv(
  workspaceRoot: string,
  token: string,
  askPassPath: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return workspaceEnv(workspaceRoot, {
    GIT_ASKPASS: askPassPath,
    GIT_TERMINAL_PROMPT: "0",
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
    ...extra,
  });
}

/** Non-interactive GitHub HTTPS env for orchestrator git and agent sandboxes. */
export async function resolveGithubHttpsGitEnv(
  workspaceRoot: string,
  token: string,
  extra: NodeJS.ProcessEnv = {},
): Promise<NodeJS.ProcessEnv> {
  const askPassPath = await prepareWorkspaceGitAuth(workspaceRoot);
  return githubHttpsGitEnv(workspaceRoot, token, askPassPath, extra);
}