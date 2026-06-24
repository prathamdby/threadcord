import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { dispatch } from "@flue/runtime";
import type { AppConfig } from "../config.js";
import setupAgent from "../agents/setup.js";
import { execa } from "../task/execa.js";
import { ensureWorkspaceDirs, workspaceEnv } from "../task/workspace-env.js";
import { summarizeError } from "../util/redact.js";
import { parseSetupProfileKey } from "./profile.js";
import type { SetupStore } from "./store.js";

export class SetupOrchestrator {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SetupStore,
  ) {}

  async startSetup(input: {
    repo: string;
    branch: string;
    model?: string;
    update: boolean;
  }): Promise<{
    runId: string;
    profileId: string;
    repo: string;
    branch: string;
    workspacePath: string;
  }> {
    const key = parseSetupProfileKey(input.repo, input.branch);
    if (!key.ok) throw new Error(key.message);
    const model = input.model ?? this.config.defaultModel;
    if (!this.config.allowedModels.includes(model)) {
      throw new Error(`Model ${model} is not allowed.`);
    }
    const workspacePath = join(
      this.config.WORKSPACE_ROOT,
      "setup",
      key.value.repo.replace("/", "-"),
      key.value.branch.replace(/\W+/g, "-"),
    );
    const { profile, run } = await this.store.createOrStartRun({
      repo: key.value.repo,
      branch: key.value.branch,
      model,
      workspacePath,
      update: input.update,
    });
    try {
      await prepareSetupWorkspace({
        repo: key.value.repo,
        branch: key.value.branch,
        workspacePath,
        githubToken: this.config.GITHUB_TOKEN,
      });
      return {
        runId: run.id,
        profileId: profile.id,
        repo: key.value.repo,
        branch: key.value.branch,
        workspacePath,
      };
    } catch (error) {
      await rm(workspacePath, { recursive: true, force: true });
      await this.store.failRun(run.id, summarizeError(error));
      throw error;
    }
  }

  async dispatchSetupAgent(input: {
    runId: string;
    repo: string;
    branch: string;
    workspacePath: string;
  }): Promise<void> {
    try {
      await dispatch(setupAgent, {
        id: `setup:${input.runId}`,
        input: {
          kind: "threadcord.setup",
          repo: input.repo,
          branch: input.branch,
          workspacePath: input.workspacePath,
        },
      });
    } catch (error) {
      await rm(input.workspacePath, { recursive: true, force: true });
      await this.store.failRun(input.runId, summarizeError(error));
    }
  }

  async handleAgentEnd(instanceId: string): Promise<boolean> {
    const run = await this.store.getRunByInstanceId(instanceId);
    if (!run) return false;
    if (run.status === "running") {
      const failed = await this.store.failRun(
        run.id,
        "Setup agent ended without saving a profile.",
      );
      if (failed) {
        await rm(run.workspacePath, { recursive: true, force: true });
      }
    }
    return true;
  }
}

async function prepareSetupWorkspace(input: {
  repo: string;
  branch: string;
  workspacePath: string;
  githubToken: string;
}): Promise<void> {
  await mkdir(input.workspacePath, { recursive: true });
  await ensureWorkspaceDirs(input.workspacePath);
  const checkoutDir = setupCheckoutDir(input.workspacePath, input.repo);
  const askPassDir = await mkdtemp(join(tmpdir(), "threadcord-git-askpass-"));
  try {
    const askPassPath = join(askPassDir, "askpass.sh");
    await writeGitAskPass(askPassPath);
    const gitEnv = workspaceEnv(input.workspacePath, {
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: "0",
      GITHUB_TOKEN: input.githubToken,
      GH_TOKEN: input.githubToken,
    });
    try {
      await execa("git", ["-C", checkoutDir, "rev-parse", "--git-dir"], {
        env: gitEnv,
      });
    } catch {
      await execa(
        "git",
        [
          "clone",
          "--branch",
          input.branch,
          "--single-branch",
          `https://github.com/${input.repo}.git`,
          checkoutDir,
        ],
        { cwd: input.workspacePath, env: gitEnv },
      );
    }
    await execa("git", ["fetch", "origin", input.branch], {
      cwd: checkoutDir,
      env: gitEnv,
    });
    await execa("git", ["checkout", "-B", input.branch, `origin/${input.branch}`], {
      cwd: checkoutDir,
      env: gitEnv,
    });
  } finally {
    await rm(askPassDir, { recursive: true, force: true });
  }
}

function setupCheckoutDir(workspacePath: string, repo: string): string {
  return join(workspacePath, basename(repo));
}

async function writeGitAskPass(path: string): Promise<void> {
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
