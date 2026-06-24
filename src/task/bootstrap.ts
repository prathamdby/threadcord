import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { execa } from "./execa.js";
import type { TaskRecord } from "../types.js";

export type BootstrapMode = "initial" | "continue";

export async function bootstrapWorkspace(
  task: TaskRecord,
  githubToken: string,
  mode: BootstrapMode,
): Promise<string> {
  await mkdir(task.workspacePath, { recursive: true });
  const checkoutDir = join(task.workspacePath, basename(task.repo));

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
      ["checkout", "-B", task.branch, `origin/${task.branch}`],
      {
        cwd: checkoutDir,
        env: gitEnv(githubToken),
      },
    );
  }

  return checkoutDir;
}

export async function runSetupInstall(
  checkoutDir: string,
  installCommand: string,
  githubToken: string,
): Promise<void> {
  await execa("bash", ["-lc", installCommand], {
    cwd: checkoutDir,
    env: gitEnv(githubToken),
    timeout: 600_000,
  });
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
