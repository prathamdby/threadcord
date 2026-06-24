export const TASK_STATUSES = [
  "draft",
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

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
  setupProfileRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTaskRecord extends TaskRequest {
  id: string;
  discordMessageId: string;
  discordThreadId: string;
  flueInstanceId: string;
  workspacePath: string;
  setupProfileRevision: number;
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
  instruction: string;
}

export interface ClaimedTurn {
  task: TaskRecord;
  instruction: string;
  source: "initial" | "followup";
}
