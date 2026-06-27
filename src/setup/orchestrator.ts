import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { dispatch } from "@flue/runtime";
import type { AppConfig } from "../config.js";
import setupAgent from "../agents/setup.js";
import { execa } from "../task/execa.js";
import {
  githubHttpsCloneUrl,
  resolveGithubHttpsGitEnv,
} from "../task/git-auth.js";
import { ensureWorkspaceDirs } from "../task/workspace-env.js";
import { summarizeError } from "../util/redact.js";
import { renderSetupProfile } from "./renderer.js";
import { parseSetupProfileKey } from "./profile.js";
import type { SetupStore } from "./store.js";
import type { ThreadRef } from "../types.js";

const SETUP_TYPING_INTERVAL_MS = 9000;
const GENERIC_SETUP_FAILURE_DETAIL =
  "The setup run encountered an error. Details have been logged.";

export class SetupOrchestrator {
  private postMessage?: (threadId: string, content: string) => Promise<void>;
  private readonly setupThreads = new Map<string, ThreadRef>();
  private readonly setupTypingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: SetupStore,
    private readonly typingIntervalMs: number = SETUP_TYPING_INTERVAL_MS,
  ) {}

  setMilestonePublisher(
    postMessage: (threadId: string, content: string) => Promise<void>,
  ): void {
    this.postMessage = postMessage;
  }

  registerSetupThread(runId: string, thread: ThreadRef): void {
    this.setupThreads.set(runId, thread);
    this.clearSetupTyping(runId);
    const timer = setInterval(() => {
      void thread.sendTyping().catch(() => {});
    }, this.typingIntervalMs);
    this.setupTypingTimers.set(runId, timer);
  }

  private clearSetupTyping(runId: string): void {
    const timer = this.setupTypingTimers.get(runId);
    if (timer) {
      clearInterval(timer);
      this.setupTypingTimers.delete(runId);
    }
  }

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
      const summary = summarizeError(error);
      console.error(`[threadcord] setup run ${input.runId} dispatch failure:`, summary);
      await this.store.failRun(input.runId, summary);
      await this.notifyRunFinished(
        input.runId,
        "failed",
        GENERIC_SETUP_FAILURE_DETAIL,
      );
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
        await this.notifyRunFinished(
          run.id,
          "failed",
          "Setup agent ended without saving a profile.",
        );
      }
    } else if (run.status === "succeeded") {
      const profile = await this.store.getProfileById(run.profileId);
      const revision = profile?.revision;
      await this.notifyRunFinished(
        run.id,
        "succeeded",
        revision !== undefined
          ? `Profile saved at revision ${revision}.`
          : "Profile saved.",
      );
    } else if (run.status === "failed" && run.errorSummary) {
      console.error(
        `[threadcord] setup run ${run.id} failure details:`,
        run.errorSummary,
      );
      await this.notifyRunFinished(
        run.id,
        "failed",
        GENERIC_SETUP_FAILURE_DETAIL,
      );
    }
    return true;
  }

  async handleAgentFailure(
    instanceId: string,
    errorSummary: string,
  ): Promise<boolean> {
    const run = await this.store.getRunByInstanceId(instanceId);
    if (!run) return false;
    console.error(
      `[threadcord] setup run ${run.id} agent failure details:`,
      errorSummary,
    );
    const failed = await this.store.failRun(
      run.id,
      summarizeError(errorSummary),
    );
    if (failed) {
      await rm(run.workspacePath, { recursive: true, force: true });
    }
    return true;
  }

  private async notifyRunFinished(
    runId: string,
    outcome: "succeeded" | "failed",
    detail: string,
  ): Promise<void> {
    this.clearSetupTyping(runId);
    this.setupThreads.delete(runId);
    const run = await this.store.getRun(runId);
    const threadId = run?.discordThreadId;
    if (!threadId) return;
    const headline =
      outcome === "succeeded"
        ? "Setup finished successfully."
        : "Setup failed.";
    await this.post(threadId, `${headline}\n${detail}`);
    if (outcome === "succeeded") {
      const profile = run
        ? await this.store.getProfileById(run.profileId)
        : undefined;
      if (profile) {
        await this.post(threadId, renderSetupProfile(profile).content);
      }
    }
  }

  private async post(threadId: string, content: string): Promise<void> {
    if (!this.postMessage) return;
    try {
      await this.postMessage(threadId, content);
    } catch (error) {
      console.error("[threadcord] setup thread post failed", error);
    }
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
  const gitEnv = await resolveGithubHttpsGitEnv(
    input.workspacePath,
    input.githubToken,
  );
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
        githubHttpsCloneUrl(input.repo),
        checkoutDir,
      ],
      { cwd: input.workspacePath, env: gitEnv },
    );
  }
  await execa("git", ["fetch", "origin", input.branch], {
    cwd: checkoutDir,
    env: gitEnv,
  });
  await execa(
    "git",
    ["checkout", "-B", input.branch, `origin/${input.branch}`],
    {
      cwd: checkoutDir,
      env: gitEnv,
    },
  );
}

function setupCheckoutDir(workspacePath: string, repo: string): string {
  return join(workspacePath, basename(repo));
}
