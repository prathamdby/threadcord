import { mkdir, rm, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { githubHttpsCloneUrl, resolveGithubHttpsGitEnv } from "./git-auth.js";
import { execa } from "./execa.js";
import { buildSkillsInstallShellCommand } from "../setup/skills.js";
import type { TaskRecord } from "../types.js";
import {
  ensureWorkspaceDirs,
  wrapWorkspaceBashCommand,
} from "./workspace-env.js";

export type BootstrapMode = "initial" | "continue";

export async function bootstrapWorkspace(
  task: TaskRecord,
  githubToken: string,
  mode: BootstrapMode,
): Promise<string> {
  await mkdir(task.workspacePath, { recursive: true });
  await ensureWorkspaceDirs(task.workspacePath);
  const checkoutDir = join(task.workspacePath, basename(task.repo));
  const gitEnv = await resolveGithubHttpsGitEnv(
    task.workspacePath,
    githubToken,
  );

  await ensureCheckoutDir(task, gitEnv, checkoutDir);
  await removeStaleGitLock(checkoutDir);

  if (mode === "initial") {
    await execa("git", ["fetch", "origin", task.branch], {
      cwd: checkoutDir,
      env: gitEnv,
    });
    await execa(
      "git",
      ["checkout", "-B", task.branch, `origin/${task.branch}`],
      {
        cwd: checkoutDir,
        env: gitEnv,
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
  const gitEnv = await resolveGithubHttpsGitEnv(workspaceRoot, githubToken);
  await execa("bash", ["-c", wrapWorkspaceBashCommand(installCommand)], {
    cwd: checkoutDir,
    env: gitEnv,
    timeout: 1_800_000,
  });
}

export async function runSetupSkillsInstall(
  workspaceRoot: string,
  checkoutDir: string,
  skillLinks: string[],
  githubToken: string,
): Promise<void> {
  if (skillLinks.length === 0) return;
  const gitEnv = await resolveGithubHttpsGitEnv(workspaceRoot, githubToken);
  const command = buildSkillsInstallShellCommand(skillLinks);
  await execa("bash", ["-c", wrapWorkspaceBashCommand(command)], {
    cwd: checkoutDir,
    env: gitEnv,
    timeout: 1_800_000,
  });
}

async function ensureCheckoutDir(
  task: TaskRecord,
  gitEnv: NodeJS.ProcessEnv,
  checkoutDir: string,
): Promise<void> {
  if (
    (await exists(checkoutDir)) &&
    !(await exists(join(checkoutDir, ".git")))
  ) {
    await rm(checkoutDir, { recursive: true, force: true });
  }
  if (!(await exists(checkoutDir))) {
    await cloneRepo(task, gitEnv, checkoutDir);
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
  gitEnv: NodeJS.ProcessEnv,
  checkoutDir: string,
): Promise<void> {
  const repoUrl = githubHttpsCloneUrl(task.repo);
  await execa(
    "git",
    ["clone", "--branch", task.branch, "--single-branch", repoUrl, checkoutDir],
    {
      cwd: task.workspacePath,
      env: gitEnv,
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
