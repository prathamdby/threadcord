export const TASK_STATUSES = [
  "draft",
  "queued",
  "running",
  "waiting",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * A task is only schedulable once it carries a real Discord thread and status
 * message. `draft` is the pre-attachment state. It is excluded from every
 * scheduler claim and from restart reconciliation by construction, so a task
 * that failed thread creation can never consume agent capacity. Promotion to
 * `queued` happens in one statement that also writes the thread identity.
 */

/**
 * Statuses that consume a concurrency slot. `cancelling` stays here on purpose.
 * A cancelled-but-still-running turn keeps its slot until the runtime confirms
 * the turn ended, so the configured limit never overcommits the host.
 */
export const ACTIVE_STATUSES = ["running", "cancelling"] as const;

/**
 * Result of a cancel request, modelling the lifecycle the user sees.
 * `terminal` stopped a task with no active turn (queued or waiting).
 * `requested` flagged a running task; its turn is still winding down.
 * `noop` means the task was already cancelling or in a terminal state.
 */
export type CancelOutcome =
  | { kind: "terminal"; task: TaskRecord }
  | { kind: "requested"; task: TaskRecord }
  | { kind: "noop"; task: TaskRecord };

export interface ParsedTaskRequest {
  instruction: string;
  repo: string;
  branch: string;
  model?: string;
  pushOverride?: string;
}

export interface TaskRequest {
  instruction: string;
  repo: string;
  branch: string;
  model: string;
  pushOverride?: string;
}

export interface TaskRecord extends Omit<TaskRequest, "model"> {
  id: string;
  discordMessageId: string;
  discordThreadId: string;
  flueInstanceId: string;
  workspacePath: string;
  model: string;
  status: TaskStatus;
  initialTurnStarted: boolean;
  statusMessageId?: string;
  errorSummary?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTaskRecord extends TaskRequest {
  id: string;
  discordMessageId: string;
  discordThreadId: string;
  flueInstanceId: string;
  workspacePath: string;
}

export interface ChannelMessage {
  id: string;
  content: string;
  authorBot: boolean;
  channelId: string;
  createThread(name: string): Promise<ThreadRef>;
  reply(content: string): Promise<void>;
}

export interface ThreadMessage {
  id: string;
  content: string;
  authorBot: boolean;
  channelId: string;
  reply(content: string): Promise<void>;
}

export interface ThreadRef {
  id: string;
  send(content: string): Promise<{ id: string }>;
  editMessage(messageId: string, content: string): Promise<void>;
}

/** Payload passed to the coding agent on each dispatched turn. */
export interface DispatchAgentInput {
  kind: "threadcord.turn";
  workspacePath: string;
  model: string;
  repo: string;
  baseBranch: string;
  featureBranch: string;
  instruction: string;
}

export interface ClaimedTurn {
  task: TaskRecord;
  instruction: string;
  source: "initial" | "followup";
}
