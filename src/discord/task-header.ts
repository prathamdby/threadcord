import type { TaskRecord } from "../types.js";

export interface TaskHeaderQueue {
  position: number;
  depth: number;
}

export interface TaskHeaderOptions {
  now: Date;
  queue?: TaskHeaderQueue | undefined;
  runningTurn?: "initial" | "follow-up" | undefined;
}

export function renderTaskHeader(
  task: TaskRecord,
  options: TaskHeaderOptions,
): string {
  const lines = [
    "**Threadcord task**",
    `State: ${plainState(task.status)}`,
    `Repo: ${task.repo}`,
    `Branch: ${task.branch}`,
    `Model: ${task.model}`,
  ];

  if (task.status === "queued" && options.queue) {
    lines.push(
      `Queue: position ${options.queue.position} of ${options.queue.depth}`,
    );
  }

  if (task.status === "running") {
    lines.push(`Turn: ${options.runningTurn ?? "running"}`);
  }

  if (task.status === "failed" && task.errorSummary) {
    lines.push(`Failure: ${singleLine(task.errorSummary)}`);
    lines.push("Next: fix the cause and send a new message in this thread.");
  }

  if (task.status === "cancelled") {
    lines.push("Outcome: no further turns will run.");
  }

  if (task.status === "completed") {
    lines.push("Outcome: closed by user.");
  }

  lines.push(`Elapsed: ${formatRelativeDuration(task.createdAt, options.now)}`);
  lines.push(`Last update: ${formatAgo(task.updatedAt, options.now)}`);

  return lines.join("\n");
}

function plainState(status: TaskRecord["status"]): string {
  switch (status) {
    case "draft":
      return "creating thread";
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "waiting":
      return "ready for a follow-up";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled, no further turns";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function singleLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

function formatAgo(from: Date, to: Date): string {
  const duration = formatRelativeDuration(from, to);
  return duration === "just now" ? duration : `${duration} ago`;
}

function formatRelativeDuration(from: Date, to: Date): string {
  const seconds = Math.max(
    0,
    Math.floor((to.getTime() - from.getTime()) / 1000),
  );
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
