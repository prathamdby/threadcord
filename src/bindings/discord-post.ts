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
  "Queue the final user-facing Discord message. Must include a ## header with substantive body. Max 1900 chars. Use post-thread-report for multi-part output. Never both.";

const POST_THREAD_REPORT_DESCRIPTION =
  "Queue a multi-part Discord report. Each part posts as a separate message. Every part needs a ## header with substantive body. Max 6 parts, 1900 chars each.";

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
