import { mkdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
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
  assertPathInsideWorkspace(checkoutDir, task.workspacePath);

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
 * Assert that the resolved checkout path is strictly inside the workspace
 * root. Fail closed with a redacted error if the invariant is violated.
 */
export function assertPathInsideWorkspace(
  checkoutPath: string,
  workspaceRoot: string,
): void {
  const resolvedCheckout = resolve(checkoutPath);
  const resolvedRoot = resolve(workspaceRoot);

  // Normalise both to their canonical forms.
  const rel = relative(resolvedRoot, resolvedCheckout);

  // A relative path that starts with ".." means the checkout escaped the
  // workspace root.  An absolute relative path (empty string is identity)
  // is also not allowed — the checkout must be a *descendant*.
  if (rel === "" || rel.startsWith("..")) {
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
