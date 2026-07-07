/** Payload stored on each pg-boss turn job. */
export interface TaskTurnJobData {
  taskId: string;
  instruction: string;
  source: "initial" | "followup";
  initiatorMessageId: string;
}