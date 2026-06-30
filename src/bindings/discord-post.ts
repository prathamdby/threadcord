import { z } from "zod";
import { hostTool } from "@rivet-dev/agentos-core";
import { USER_TURN_MESSAGE_LIMIT } from "../discord/limits.js";
import { validateFinalOutput } from "../discord/final-output-validator.js";
import {
  queuePendingUserTurnMessages,
  setPendingUserTurnMessage,
} from "../discord/user-turn-message.js";
import { redact } from "../util/redact.js";
import type { BindingsHost, HostTool, ToolOutput } from "./types.js";
import { toolError, toolResult } from "./types.js";

const POST_THREAD_MESSAGE_DESCRIPTION =
  "Queue the final user-facing message for this Discord thread. This IS the deliverable the operator will read; it is not a status line. Markdown renders: ## headers, **bold**, fenced code, > blockquote, [links](url), `inline code`. Max 1900 chars per message; use post_thread_report for anything longer or multi-part. The message must contain at least one ## section header with substantive body text (what was done, files changed, conclusions). Thin outputs like '## Summary\\nDone.' are rejected. If validation fails, expand with concrete facts from the turn. Call this OR post_thread_report, never both in the same turn. For investigations, explanations, or reports of any length, prefer post_thread_report so you can structure the answer across sections. Do not include the prompt, GITHUB_TOKEN, env values, or @everyone/@here/@role pings.";

const POST_THREAD_REPORT_DESCRIPTION =
  "Queue a multi-part report for this Discord thread. Each part posts as its own message in order, after the turn ends. Use for investigations, explanations, design write-ups, or any final output >1900 chars. Markdown renders per part: ## headers, fenced code, blockquotes, links. Each part must contain at least one ## section header with substantive body text (at least 20 chars of concrete detail). Thin parts like '## Summary\\nDone.' are rejected. Structure investigations as: tl;dr -> Root cause -> Evidence -> Impact -> Fix sketch -> Open questions. Structure code-change turns as: Summary -> Changes -> Verification -> PR. Call this OR post_thread_message, never both in the same turn.";

const PostThreadMessageInputSchema = z.object({
  instanceId: z.string().min(1),
  message: z.string().min(1).max(USER_TURN_MESSAGE_LIMIT),
});

const PostThreadReportInputSchema = z.object({
  instanceId: z.string().min(1),
  parts: z
    .array(z.string().min(1).max(USER_TURN_MESSAGE_LIMIT))
    .min(1)
    .max(6),
});

export function createPostThreadMessageTool(
  host: BindingsHost,
): HostTool<z.infer<typeof PostThreadMessageInputSchema>, ToolOutput> {
  return hostTool({
    description: POST_THREAD_MESSAGE_DESCRIPTION,
    inputSchema: PostThreadMessageInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }
      const validationError = validateFinalOutput(input.message);
      if (validationError) {
        return toolError(validationError);
      }
      try {
        setPendingUserTurnMessage(resolved.instanceId, input.message);
      } catch (error) {
        return toolError(
          error instanceof Error
            ? error.message
            : "Failed to queue message for Discord.",
        );
      }
      return toolResult("Message queued for Discord.");
    },
  });
}

export function createPostThreadReportTool(
  host: BindingsHost,
): HostTool<z.infer<typeof PostThreadReportInputSchema>, ToolOutput> {
  return hostTool({
    description: POST_THREAD_REPORT_DESCRIPTION,
    inputSchema: PostThreadReportInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }
      for (let i = 0; i < input.parts.length; i++) {
        const validationError = validateFinalOutput(input.parts[i]!);
        if (validationError) {
          return toolError(`Part ${i + 1}: ${validationError}`);
        }
      }
      try {
        queuePendingUserTurnMessages(resolved.instanceId, input.parts);
      } catch (error) {
        return toolError(
          error instanceof Error
            ? error.message
            : "Failed to queue report parts for Discord.",
        );
      }
      return toolResult(`${input.parts.length} report part(s) queued for Discord.`);
    },
  });
}

export {
  POST_THREAD_MESSAGE_DESCRIPTION,
  POST_THREAD_REPORT_DESCRIPTION,
};
