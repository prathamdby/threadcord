import { z } from "zod";
import { hostTool } from "@rivet-dev/agentos-core";
import { DISCORD_MESSAGE_CONTENT_LIMIT, clampDiscordContent } from "../discord/limits.js";
import type { BindingsHost, HostTool, ToolOutput } from "./types.js";
import { toolResult, toolError } from "./types.js";

const EDIT_THREAD_MESSAGE_DESCRIPTION =
  "Edit an existing message in the Discord thread. Long content is clamped automatically. Do not include secrets or @everyone/@here/@role pings.";

const EditThreadMessageInputSchema = z.object({
  instanceId: z.string().min(1),
  messageId: z.string().min(1),
  content: z.string().min(1).max(DISCORD_MESSAGE_CONTENT_LIMIT),
});

export function createEditThreadMessageTool(
  host: BindingsHost,
): HostTool<z.infer<typeof EditThreadMessageInputSchema>, ToolOutput> {
  return hostTool({
    description: EDIT_THREAD_MESSAGE_DESCRIPTION,
    inputSchema: EditThreadMessageInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }
      await host.editMessage(resolved.threadId, input.messageId, clampDiscordContent(input.content));
      return toolResult("Message edited on Discord.");
    },
  });
}

export { EDIT_THREAD_MESSAGE_DESCRIPTION };
