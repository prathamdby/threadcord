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
  flueInstanceId: string;
  workspacePath: string;
  setupProfileRevision: number;
}

export const TURN_STATUSES = [
  "queued",
  "running",
  "cancelled",
  "completed",
  "failed",
] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

export interface TaskTurnRecord {
  id: string; // uuid generated with crypto.randomUUID()
  taskId: string;
  source: "initial" | "followup";
  instruction: string;
  discordMessageId?: string; // conditionally spread, exactOptionalPropertyTypes
  status: TurnStatus;
  attemptCount: number;
  cancelRequestedAt?: Date;
  lastError?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
}

export interface ChannelMessage {
  id: string;
  content: string;
  authorBot: boolean;
  channelId: string;
  attachments?: ThreadMessageAttachment[] | undefined;
  createThread(name: string): Promise<TaskThreadRef>;
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

/** Thread handle with Components-v2 send/edit support (see discord-thread.ts). */
export interface TaskThreadRef extends ThreadRef {
  sendView(payload: import("./discord/ui/index.js").ViewPayload): Promise<{ id: string }>;
  editView(
    messageId: string,
    payload: import("./discord/ui/index.js").ViewPayload,
  ): Promise<void>;
}

/** Attachment metadata extracted from a Discord message (images, files). */
export interface ThreadMessageAttachment {
  url: string;
  name: string;
  contentType: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Quoted content of an earlier Discord message that a follow-up message was a
 * reply to (Discord's reply/reference feature). Forwarded into the agent prompt
 * so the agent sees what the user was replying to.
 */
export interface ThreadMessageReplyQuote {
  /** The referenced message content, clamped to a safe length. */
  content: string;
  /** Whether the referenced message was authored by this bot (the agent itself). */
  authorBot: boolean;
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
