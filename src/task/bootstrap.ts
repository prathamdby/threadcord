import { mkdir, realpath as fsRealpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "./execa.js";
import { targetBranchForTask } from "./policy.js";
import type { TaskRecord } from "../types.js";

export type BootstrapMode = "initial" | "continue";

export async function bootstrapWorkspace(
  task: TaskRecord,
  githubToken: string,
  mode: BootstrapMode,
): Promise<string> {
  await mkdir(task.workspacePath, { recursive: true });
  const checkoutDir = join(task.workspacePath, basename(task.repo));
  const featureBranch = targetBranchForTask(task.id, task);

  // Path containment guard: ensure the derived checkout directory remains
  // inside the task's designated workspace. This is a safety net in case
  // a task record with a manipulated repo name reaches bootstrap.
  await assertPathInsideWorkspace(checkoutDir, task.workspacePath);

  if (!(await exists(checkoutDir))) {
    await cloneRepo(task, githubToken, checkoutDir);
  }

  if (mode === "initial") {
    await execa("git", ["fetch", "origin", task.branch], {
      cwd: checkoutDir,
      env: gitEnv(githubToken),
    });
    await execa(
      "git",
      ["checkout", "-B", featureBranch, `origin/${task.branch}`],
      {
        cwd: checkoutDir,
        env: gitEnv(githubToken),
      },
    );
  } else {
    await execa("git", ["checkout", featureBranch], {
      cwd: checkoutDir,
      env: gitEnv(githubToken),
    });
  }

  return checkoutDir;
}

/**
 * Like `fs.realpath()` but falls back to `resolve()` if the path does not
 * exist. Non-existent paths cannot host symlinks, so the safe fallback is
 * correct while keeping the guard usable in unit tests without creating
 * every test path on disk.
 */
async function safeRealpath(path: string): Promise<string> {
  try {
    return await fsRealpath(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return resolve(path);
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Assert that the resolved checkout path is strictly inside the workspace
 * root. Fail closed with a redacted error if the invariant is violated.
 *
 * Uses `fs.realpath()` to resolve symlinks when the path exists, closing
 * the symlink-escape vector. Falls back to `resolve` for non-existent
 * paths (which cannot host symlinks).
 */
export async function assertPathInsideWorkspace(
  checkoutPath: string,
  workspaceRoot: string,
): Promise<void> {
  const resolvedCheckout = await safeRealpath(resolve(checkoutPath));
  const resolvedRoot = await safeRealpath(resolve(workspaceRoot));

  const rel = relative(resolvedRoot, resolvedCheckout);

  // A relative path that starts with ".." means the checkout escaped the
  // workspace root. An empty string means identity — the checkout must be a
  // *descendant*. On Windows, if the two paths are on different drives,
  // `relative` returns an absolute path, so we check `isAbsolute` too.
  if (
    rel === "" ||
    rel.startsWith("..") ||
    isAbsolute(rel)
  ) {
    throw new Error(
      "Workspace checkout path escaped the task workspace. This incident will be logged.",
    );
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
    { cwd: task.workspacePath, env: gitEnv(githubToken) },
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

function gitEnv(token: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
  };
}
