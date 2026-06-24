import { mkdir, rm, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { execa } from "./execa.js";
import type { TaskRecord } from "../types.js";
import { ensureWorkspaceDirs, workspaceEnv } from "./workspace-env.js";

export type BootstrapMode = "initial" | "continue";

export async function bootstrapWorkspace(
  task: TaskRecord,
  githubToken: string,
  mode: BootstrapMode,
): Promise<string> {
  await mkdir(task.workspacePath, { recursive: true });
  await ensureWorkspaceDirs(task.workspacePath);
  const checkoutDir = join(task.workspacePath, basename(task.repo));

  await ensureCheckoutDir(task, githubToken, checkoutDir);
  await removeStaleGitLock(checkoutDir);

  if (mode === "initial") {
    await execa("git", ["fetch", "origin", task.branch], {
      cwd: checkoutDir,
      env: scopedGitEnv(task.workspacePath, githubToken),
    });
    await execa(
      "git",
      ["checkout", "-B", task.branch, `origin/${task.branch}`],
      {
        cwd: checkoutDir,
        env: scopedGitEnv(task.workspacePath, githubToken),
      },
    );
  }

  return checkoutDir;
}

export async function runSetupInstall(
  workspaceRoot: string,
  checkoutDir: string,
  installCommand: string,
  githubToken: string,
): Promise<void> {
  await execa("bash", ["-lc", installCommand], {
    cwd: checkoutDir,
    env: scopedGitEnv(workspaceRoot, githubToken),
    timeout: 600_000,
  });
}

async function ensureCheckoutDir(
  task: TaskRecord,
  githubToken: string,
  checkoutDir: string,
): Promise<void> {
  if (await exists(checkoutDir) && !(await exists(join(checkoutDir, ".git")))) {
    await rm(checkoutDir, { recursive: true, force: true });
  }
  if (!(await exists(checkoutDir))) {
    await cloneRepo(task, githubToken, checkoutDir);
  }
}

async function removeStaleGitLock(checkoutDir: string): Promise<void> {
  const lockPath = join(checkoutDir, ".git", "index.lock");
  if (await exists(lockPath)) {
    await unlink(lockPath);
  }
}

async function cloneRepo(
  task: TaskRecord,
  githubToken: string,
  checkoutDir: string,
): Promise<void> {
  const repoUrl = `https://github.com/${task.repo}.git`;
  await execa(
    "git",
    ["clone", "--branch", task.branch, "--single-branch", repoUrl, checkoutDir],
    {
      cwd: task.workspacePath,
      env: scopedGitEnv(task.workspacePath, githubToken),
    },
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function scopedGitEnv(
  workspaceRoot: string,
  token: string,
): NodeJS.ProcessEnv {
  return workspaceEnv(workspaceRoot, {
    GIT_TERMINAL_PROMPT: "0",
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
  });
}
