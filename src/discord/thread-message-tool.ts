import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import {
  DISCORD_FINAL_OUTPUT_MAX_CHARS,
  DISCORD_FINAL_REPORT_MAX_PARTS,
  POST_THREAD_MESSAGE_DESCRIPTION,
  POST_THREAD_REPORT_DESCRIPTION,
} from "./final-output-contract.js";
import {
  hasPendingUserTurnMessages,
  queuePendingUserTurnMessages,
  setPendingUserTurnMessage,
} from "./user-turn-message.js";
import { validateFinalOutput } from "./final-output-validator.js";

export function createPostThreadMessageTool(instanceId: string) {
  return defineTool({
    name: "post_thread_message",
    description: POST_THREAD_MESSAGE_DESCRIPTION,
    parameters: v.object({
      message: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(
          DISCORD_FINAL_OUTPUT_MAX_CHARS,
          `message exceeds ${DISCORD_FINAL_OUTPUT_MAX_CHARS} chars; use post_thread_report(parts: string[]) for longer or multi-part output`,
        ),
      ),
    }),
    async execute(input) {
      if (hasPendingUserTurnMessages(instanceId)) {
        throw new Error(
          "This turn already has a queued report. Combine into a single call.",
        );
      }
      const validationError = validateFinalOutput(input.message);
      if (validationError) {
        throw new Error(validationError);
      }
      setPendingUserTurnMessage(instanceId, input.message);
      return "Message queued for Discord.";
    },
  });
}

export function createPostThreadReportTool(instanceId: string) {
  return defineTool({
    name: "post_thread_report",
    description: POST_THREAD_REPORT_DESCRIPTION,
    parameters: v.object({
      parts: v.pipe(
        v.array(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(
              DISCORD_FINAL_OUTPUT_MAX_CHARS,
              `each part must be <=${DISCORD_FINAL_OUTPUT_MAX_CHARS} chars; split into more parts`,
            ),
          ),
        ),
        v.minLength(1),
        v.maxLength(DISCORD_FINAL_REPORT_MAX_PARTS),
      ),
    }),
    async execute(input) {
      for (let i = 0; i < input.parts.length; i++) {
        const part = input.parts[i]!;
        const validationError = validateFinalOutput(part);
        if (validationError) {
          throw new Error(`Part ${i + 1}: ${validationError}`);
        }
      }
      queuePendingUserTurnMessages(instanceId, input.parts);
      return `${input.parts.length} report part(s) queued for Discord.`;
    },
  });
}

export function createThreadMessageTools(instanceId: string) {
  return [
    createPostThreadMessageTool(instanceId),
    createPostThreadReportTool(instanceId),
  ];
}

export {
  POST_THREAD_MESSAGE_DESCRIPTION,
  POST_THREAD_REPORT_DESCRIPTION,
} from "./final-output-contract.js";