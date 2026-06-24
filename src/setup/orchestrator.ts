import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { dispatch } from "@flue/runtime";
import type { AppConfig } from "../config.js";
import setupAgent from "../agents/setup.js";
import { execa } from "../task/execa.js";
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
  }): Promise<{ runId: string; profileId: string; workspacePath: string }> {
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
      await dispatch(setupAgent, {
        id: `setup:${run.id}`,
        input: {
          kind: "threadcord.setup",
          repo: key.value.repo,
          branch: key.value.branch,
          workspacePath,
        },
      });
      return { runId: run.id, profileId: profile.id, workspacePath };
    } catch (error) {
      await rm(workspacePath, { recursive: true, force: true });
      await this.store.failRun(run.id, summarizeError(error));
      throw error;
    }
  }

  async handleAgentEnd(instanceId: string): Promise<boolean> {
    const run = await this.store.getRunByInstanceId(instanceId);
    if (!run) return false;
    if (run.status === "running") {
      await this.store.failRun(run.id, "Setup agent ended without saving a profile.");
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
  const checkoutDir = setupCheckoutDir(input.workspacePath, input.repo);
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GITHUB_TOKEN: input.githubToken,
    GH_TOKEN: input.githubToken,
  };
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
        `https://x-access-token:${input.githubToken}@github.com/${input.repo}.git`,
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
}

function setupCheckoutDir(workspacePath: string, repo: string): string {
  return join(workspacePath, basename(repo));
}
