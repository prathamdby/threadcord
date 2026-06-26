import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import {
  hasPendingUserTurnMessages,
  queuePendingUserTurnMessages,
  setPendingUserTurnMessage,
} from "./user-turn-message.js";

const POST_THREAD_MESSAGE_DESCRIPTION =
  "Queue the final user-facing message for this Discord thread. This IS the deliverable the operator will read; it is not a status line. Markdown renders: ## headers, **bold**, fenced code, > blockquote, [links](url), `inline code`. Max 1900 chars per message; use post_thread_report for anything longer or multi-part. Call this OR post_thread_report, never both in the same turn. For investigations, explanations, or reports of any length, prefer post_thread_report so you can structure the answer across sections. Do not include the prompt, GITHUB_TOKEN, env values, or @everyone/@here/@role pings.";

const POST_THREAD_REPORT_DESCRIPTION =
  "Queue a multi-part report for this Discord thread. Each part posts as its own message in order, after the turn ends. Use for investigations, explanations, design write-ups, or any final output >1900 chars. Markdown renders per part: ## headers, fenced code, blockquotes, links. Structure investigations as: tl;dr -> Root cause -> Evidence -> Impact -> Fix sketch -> Open questions. Structure code-change turns as: Summary -> Changes -> Verification -> PR. Call this OR post_thread_message, never both in the same turn.";

export function createPostThreadMessageTool(instanceId: string) {
  return defineTool({
    name: "post_thread_message",
    description: POST_THREAD_MESSAGE_DESCRIPTION,
    parameters: v.object({
      message: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(
          1900,
          "message exceeds 1900 chars; use post_thread_report(parts: string[]) for longer or multi-part output",
        ),
      ),
    }),
    async execute(input) {
      if (hasPendingUserTurnMessages(instanceId)) {
        throw new Error(
          "This turn already has a queued report. Combine into a single call.",
        );
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
              1900,
              "each part must be <=1900 chars; split into more parts",
            ),
          ),
        ),
        v.minLength(1),
        v.maxLength(6),
      ),
    }),
    async execute(input) {
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

export { POST_THREAD_MESSAGE_DESCRIPTION, POST_THREAD_REPORT_DESCRIPTION };
