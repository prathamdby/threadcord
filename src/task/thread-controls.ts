import {
  buildCustomId,
  confirmView,
  infoView,
  parseCustomId,
  type ViewPayload,
} from "../discord/ui/index.js";

export type ThreadControlCommand = "abort" | "cancel" | "done";

export interface ParsedThreadControlButton {
  kind: "confirm" | "dismiss";
  command: ThreadControlCommand;
  userId: string;
  taskId: string;
}

const CONTROL_COMMANDS = new Set<ThreadControlCommand>([
  "abort",
  "cancel",
  "done",
]);

export function buildThreadControlConfirmIds(input: {
  command: ThreadControlCommand;
  userId: string;
  taskId: string;
}): { confirm: string; dismiss: string } {
  const { command, userId, taskId } = input;
  return {
    confirm: buildCustomId("task", "ctl", "confirm", command, userId, taskId),
    dismiss: buildCustomId("task", "ctl", "dismiss", command, userId, taskId),
  };
}

export function parseThreadControlButtonCustomId(
  raw: string,
): ParsedThreadControlButton | undefined {
  const parsed = parseCustomId(raw);
  if (!parsed || parsed.action !== "ctl") return undefined;
  const [kind, command, userId, taskId] = parsed.params;
  if (
    (kind !== "confirm" && kind !== "dismiss") ||
    !command ||
    !userId ||
    !taskId ||
    !CONTROL_COMMANDS.has(command as ThreadControlCommand)
  ) {
    return undefined;
  }
  return {
    kind,
    command: command as ThreadControlCommand,
    userId,
    taskId,
  };
}

export function buildThreadControlConfirmView(input: {
  command: ThreadControlCommand;
  userId: string;
  taskId: string;
  prompt: string;
}): ViewPayload {
  const ids = buildThreadControlConfirmIds(input);
  return confirmView(input.prompt, ids.confirm, ids.dismiss);
}

export function controlPrompt(command: ThreadControlCommand): string {
  switch (command) {
    case "abort":
      return "Abort this task? The in-flight agent turn will be stopped.";
    case "cancel":
      return "Cancel this task? No further turns will run.";
    case "done":
      return "Mark this task complete?";
  }
}

export function controlOutcomeView(
  command: ThreadControlCommand,
  ok: boolean,
  detail?: string,
): ViewPayload {
  if (!ok) {
    return infoView("Action not completed", detail ?? "The task could not be completed.");
  }
  switch (command) {
    case "abort":
      return infoView(
        "Aborted",
        "The in-flight agent turn was stopped and no further turns will run.",
      );
    case "cancel":
      return infoView("Cancelled", "No further turns will be dispatched for this task.");
    case "done":
      return infoView("Complete", "Task marked complete.");
  }
}

export function dismissedControlView(): ViewPayload {
  return infoView("Cancelled", "");
}
