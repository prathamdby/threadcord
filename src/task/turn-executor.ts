/**
 * Durable turn executor driven by pg-boss jobs.
 *
 * Each pg-boss job for the `task-turn` queue carries a `{ turnId, taskId,
 * flueInstanceId, source }` payload. The executor claims the turn row,
 * transitions the task to running, prepares the workspace (bootstrap +
 * setup-install + prompt), dispatches the Flue agent turn, and then awaits
 * the in-process completion bridge (`turn-completion.ts`) for the outcome.
 *
 * On success the turn is completed and the task returns to waiting. On
 * failure the turn is retried (if attempts remain) or permanently failed,
 * matching the old orchestrator.runTurn catch block but with backoff via
 * pg-boss instead of an immediate permanent fail.
 *
 * Key ordering invariant: the completion-bridge waiter is registered BEFORE
 * dispatch (see step 2.5) so a fast agent cannot finish before the waiter
 * exists.
 */

import type { JobWithMetadata } from "pg-boss";
import type { AppConfig } from "../config.js";
import { failureDiscordMessage } from "../discord/observe-bridge.js";
import { isFlueInstanceRunning } from "../flue/agent-work-abort.js";
import { summarizeError } from "../util/redact.js";
import type { SetupEnvironment, SetupProfile } from "../setup/profile.js";
import type { SetupStore } from "../setup/store.js";
import type {
  DispatchAgentInput,
  TaskRecord,
  TaskTurnRecord,
} from "../types.js";
import { runSetupSkillsInstall } from "./bootstrap.js";
import type {
  BootstrapTurn,
  DispatchTurn,
  RunSetupInstallTurn,
} from "./orchestrator.js";
import type { TaskStore } from "./store.js";
import {
  clearTurnWaiter,
  waitForTurnOutcome,
  type TurnOutcome,
} from "./turn-completion.js";
import type { TurnStore } from "./turn-store.js";

/** Payload stored on each pg-boss task-turn job. */
export interface TurnJobData {
  turnId: string;
  taskId: string;
  flueInstanceId: string;
  source: "initial" | "followup";
}

/**
 * Discord-side hooks the executor calls to mutate orchestrator-held state
 * (in-flight tracking, header refresh, typing, reactions, thread lifecycle).
 * The orchestrator implements this interface.
 */
export interface TurnExecutorHooks {
  /** Set up the in-flight turn entry and dequeue the initiator reaction handle. */
  beginTurn(task: TaskRecord, initiatorMessageId?: string): void;
  /** Refresh the task header, optionally marking the running turn kind. */
  refreshHeader(taskId: string, runningTurn?: "initial" | "follow-up"): Promise<void>;
  /** Post a message to the task thread (no-op for pending threads). */
  postToThread(threadId: string, content: string): Promise<void>;
  /** Start the typing indicator loop for a task, storing the timer in-flight. */
  startTypingLoopForTask(task: TaskRecord): void;
  /** Schedule a readable thread rename based on the instruction (initial only). */
  scheduleRename(threadId: string, instruction: string): void;
  /** Post-turn side effects for a completed turn: drain user messages, refresh header, flip to ✅. */
  onTurnCompleted(task: TaskRecord): Promise<void>;
  /** Side effects for a terminally failed turn: drain, post failure, refresh header, flip to ❌, dispose. */
  onTurnFailed(task: TaskRecord, errorSummary: string): Promise<void>;
  /** Clear in-flight state without side effects (cancel/retry cleanup). */
  clearInFlightState(instanceId: string): void;
}

export interface TurnExecutorDeps {
  turnStore: TurnStore;
  taskStore: TaskStore;
  setupStore: SetupStore;
  config: AppConfig;
  dispatchTurn: DispatchTurn;
  bootstrap: BootstrapTurn;
  runSetupInstallTurn: RunSetupInstallTurn;
  hooks: TurnExecutorHooks;
}

/**
 * Execute a single pg-boss turn job. Designed to be registered via
 * `boss.work(TASK_TURN_QUEUE, { includeMetadata: true, ... }, async ([job]) =>
 * executeTurnJob(deps, job))`.
 */
export async function executeTurnJob(
  deps: TurnExecutorDeps,
  job: JobWithMetadata<TurnJobData>,
): Promise<void> {
  const { turnStore, taskStore, setupStore, config, hooks } = deps;
  const { turnId, taskId, flueInstanceId, source } = job.data;

  // -- 2.1 Claim -----------------------------------------------------------
  let turn = await turnStore.claimQueuedTurn(turnId);
  let isResume = false;
  if (!turn) {
    const resumed = await turnStore.resumeTurnForExecution(turnId);
    if (!resumed) {
      // Turn is terminal or cancel-gated; job completes, no work.
      return;
    }
    isResume = true;
    turn = await turnStore.getTurn(turnId);
    if (!turn) return;
  }

  // Resume path: check Flue liveness. If the agent is still running, skip
  // re-dispatch and go straight to awaiting the outcome.
  const skipDispatch =
    isResume && (await isFlueInstanceRunning(flueInstanceId));

  // Load the task (needed for both dispatch and settle paths).
  let task = await taskStore.getByInstanceId(flueInstanceId);
  if (!task) return;

  if (!skipDispatch) {
    // -- 2.2 Task transition ----------------------------------------------
    const transitioned = await taskStore.transition(
      taskId,
      ["queued", "waiting"],
      "running",
    );
    if (transitioned) {
      task = transitioned;
    } else if (!isResume) {
      // A concurrent cancel/failure changed the status; treat as cancel.
      await turnStore.markTurnCancelled(turnId);
      return;
    }
    // On resume with task already running, task is already fetched above.
  }

  try {
    if (skipDispatch) {
      // Resume-live: agent is still running, just await the outcome.
      const outcome = await waitForTurnOutcome(flueInstanceId);
      await settleOutcome(deps, turn, task, outcome);
      return;
    }

    // -- 2.3 Prepare ------------------------------------------------------
    hooks.beginTurn(task, turn.discordMessageId);
    await hooks.refreshHeader(
      task.id,
      source === "initial" ? "initial" : "follow-up",
    );

    const checkoutPath = await deps.bootstrap(
      task,
      config.GITHUB_TOKEN,
      source === "initial" ? "initial" : "continue",
    );

    // Checkpoint after bootstrap: cancel-gate.
    if (await turnStore.shouldSkipTurn(turn.id)) {
      await turnStore.markTurnCancelled(turn.id);
      clearTurnWaiter(flueInstanceId);
      hooks.clearInFlightState(task.flueInstanceId);
      await taskStore.transition(task.id, "running", "waiting");
      return;
    }

    const setupProfile = await setupStore.getReadyProfile(
      task.repo,
      task.branch,
    );
    if (!setupProfile) {
      throw new Error(
        `Missing ready setup profile for ${task.repo} on ${task.branch}`,
      );
    }

    if (source === "initial") {
      await deps.runSetupInstallTurn(
        task.workspacePath,
        checkoutPath,
        setupProfile.environment.install,
        config.GITHUB_TOKEN,
      );
      const skillLinks = setupProfile.environment.skills ?? [];
      if (skillLinks.length > 0) {
        await runSetupSkillsInstall(
          task.workspacePath,
          checkoutPath,
          skillLinks,
          config.GITHUB_TOKEN,
        );
      }
    }

    // Re-check task status before dispatching (concurrent cancel may have
    // transitioned the task out of running during setup).
    const current = await taskStore.getByInstanceId(task.flueInstanceId);
    if (!current || current.status !== "running") {
      hooks.clearInFlightState(task.flueInstanceId);
      return;
    }

    const fullPrompt = buildPrompt(
      task,
      checkoutPath,
      setupProfile.revision,
      setupProfile.environment,
      setupProfile.memoryMarkdown,
      turn.instruction,
    );
    const input: DispatchAgentInput = {
      kind: "threadcord.turn",
      workspacePath: checkoutPath,
      model: task.model,
      repo: task.repo,
      baseBranch: task.branch,
      instruction: fullPrompt,
    };

    if (source === "initial") {
      hooks.scheduleRename(task.discordThreadId, turn.instruction);
    }

    // -- 2.5 Register waiter BEFORE dispatch -------------------------------
    const outcomePromise = waitForTurnOutcome(flueInstanceId);

    // -- 2.4 Dispatch -----------------------------------------------------
    await deps.dispatchTurn(flueInstanceId, input);
    hooks.startTypingLoopForTask(task);
    await hooks.postToThread(task.discordThreadId, "Agent turn accepted.");

    // -- 2.6 Await outcome ------------------------------------------------
    const outcome = await outcomePromise;
    await settleOutcome(deps, turn, task, outcome);
  } catch (error) {
    await handleTurnError(deps, job, turn, task, error);
  }
}

/** Settle the turn row and task status based on the observed outcome. */
async function settleOutcome(
  deps: TurnExecutorDeps,
  turn: TaskTurnRecord,
  task: TaskRecord,
  outcome: TurnOutcome,
): Promise<void> {
  const { turnStore, taskStore, hooks } = deps;

  if (outcome.kind === "completed") {
    const completed = await turnStore.markTurnCompleted(turn.id);
    if (!completed) {
      // A cancel won the race — do cancel cleanup instead.
      await turnStore.markTurnCancelled(turn.id);
      clearTurnWaiter(task.flueInstanceId);
      hooks.clearInFlightState(task.flueInstanceId);
      return;
    }
    await taskStore.transition(task.id, "running", "waiting");
    await hooks.onTurnCompleted(task);
    return;
  }

  if (outcome.kind === "cancelled") {
    await turnStore.markTurnCancelled(turn.id);
    clearTurnWaiter(task.flueInstanceId);
    hooks.clearInFlightState(task.flueInstanceId);
    // No task transition — the cancel path (plan 004) owns it.
    return;
  }

  // failed → treat like a thrown error so agent failures get retry
  // classification (the error handler below decides retry vs terminal).
  throw new Error(outcome.errorSummary);
}

/**
 * Error handler wrapping steps 2.2–2.6. Decides between cancel cleanup,
 * retry-with-backoff (rethrow), and terminal failure.
 */
async function handleTurnError(
  deps: TurnExecutorDeps,
  job: JobWithMetadata<TurnJobData>,
  turn: TaskTurnRecord,
  task: TaskRecord,
  error: unknown,
): Promise<void> {
  const { turnStore, taskStore, hooks } = deps;
  const { taskId, flueInstanceId } = job.data;

  // If the turn was cancelled or is terminal, abandon.
  if (await turnStore.shouldSkipTurn(turn.id)) {
    await turnStore.markTurnCancelled(turn.id);
    clearTurnWaiter(flueInstanceId);
    hooks.clearInFlightState(task.flueInstanceId);
    return;
  }

  const summary = summarizeError(error);
  console.error(
    `[threadcord] task ${task.id} turn failure details:`,
    summary,
  );

  if (job.retryCount < job.retryLimit) {
    // Non-terminal: mark retrying, put task back to queued, rethrow for backoff.
    await turnStore.markTurnRetrying(turn.id, summary);
    await taskStore.transition(taskId, "running", "queued");
    hooks.clearInFlightState(task.flueInstanceId);
    await hooks.refreshHeader(taskId);
    await hooks.postToThread(
      task.discordThreadId,
      "Turn hit an error, retrying.",
    );
    throw error;
  }

  // Terminal: permanent failure — same side-effects as today's catch block.
  await turnStore.markTurnFailed(turn.id, summary);
  await taskStore.transition(taskId, "running", "failed", summary);
  clearTurnWaiter(flueInstanceId);
  await hooks.onTurnFailed(task, summary);
}

// -- Prompt builder (moved from orchestrator.runTurn) -----------------------

function buildPrompt(
  task: TaskRecord,
  checkoutPath: string,
  activeSetupProfileRevision: number,
  setupEnvironment: SetupEnvironment,
  setupMemoryMarkdown: string,
  instruction: string,
): string {
  const lines = [
    `Task id: ${task.id}`,
    `Repository: ${task.repo}`,
    `Base branch: ${task.branch}`,
    ...(task.pushOverride ? [`Push override: ${task.pushOverride}`] : []),
    `Workspace: ${checkoutPath}`,
    `Model: ${task.model}`,
    `Admitted setup profile revision: ${task.setupProfileRevision}`,
    `Active setup profile revision: ${activeSetupProfileRevision}`,
    `Setup install command: ${setupEnvironment.install}`,
    `Setup skills: ${
      setupEnvironment.skills?.length
        ? setupEnvironment.skills.join("; ")
        : "none"
    }`,
    `Setup checks: ${formatChecks(setupEnvironment.checks)}`,
    `Required env: ${setupEnvironment.requiredEnv.join(", ") || "none"}`,
    `Required services: ${setupEnvironment.requiredServices.join(", ") || "none"}`,
    "",
    "Setup profile memory:",
    setupMemoryMarkdown,
    "",
    instruction,
  ];
  return lines.join("\n");
}

function formatChecks(checks: Record<string, string>): string {
  const entries = Object.entries(checks);
  if (entries.length === 0) return "none";
  return entries.map(([name, command]) => `${name}=${command}`).join("; ");
}
