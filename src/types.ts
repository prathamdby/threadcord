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
  agentInstanceId: string;
  workspacePath: string;
  model: string;
  status: TaskStatus;
  initialTurnStarted: boolean;
  progressMessageIds?: string[];
  statusMessageId?: string;
  headerMessageId?: string;
  errorSummary?: string;
  setupProfileRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTaskRecord extends TaskRequest {
  id: string;
  discordMessageId: string;
  discordThreadId: string;
  agentInstanceId: string;
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
  react(emoji: string): Promise<void>;
  unreact(emoji: string): Promise<void>;
}

export interface ThreadMessage {
  id: string;
  content: string;
  authorBot: boolean;
  channelId: string;
  guildId?: string | null | undefined;
  reply(content: string): Promise<void>;
  react(emoji: string): Promise<void>;
  unreact(emoji: string): Promise<void>;
}

export interface ThreadRef {
  id: string;
  send(content: string): Promise<{ id: string }>;
  pin(messageId: string): Promise<void>;
  editMessage(messageId: string, content: string): Promise<void>;
  sendTyping(): Promise<void>;
  setName(name: string): Promise<void>;
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
  // id (not the live handle) so the postgres TaskStore can populate it; the
  // orchestrator re-resolves the reaction handle from its own in-memory map.
  initiatorMessageId: string;
}
