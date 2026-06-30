import { z } from "zod";
import { hostTool } from "@rivet-dev/agentos-core";
import {
  SETUP_MEMORY_APPEND_MAX_CHARS,
  validateSetupMemoryAppend,
} from "../setup/profile.js";
import type { BindingsHost, HostTool, ToolOutput } from "./types.js";
import { toolResult, toolError } from "./types.js";

export const APPEND_THREADCORD_SETUP_MEMORY_DESCRIPTION =
  "Append durable Markdown to the setup profile memory for this task's repository and base branch. Future coding turns load the updated block under Setup profile memory. Does not change install, checks, or environment JSON. Append only after you verified a fix or learned a stable repo fact worth repeating (gotchas, test quirks, operator prefs, non-obvious paths). One short paragraph or bullet list per call; <=4000 chars; names only for env vars; no secret values. On success increments profile revision; new tasks pick up the revision automatically, in-flight tasks keep their admitted revision until the next turn.";

const AppendSetupMemoryInputSchema = z.object({
  instanceId: z.string().min(1),
  markdown: z.string().min(1).max(SETUP_MEMORY_APPEND_MAX_CHARS),
});

export function createAppendSetupMemoryTool(
  host: BindingsHost,
): HostTool<z.infer<typeof AppendSetupMemoryInputSchema>, ToolOutput> {
  return hostTool({
    description: APPEND_THREADCORD_SETUP_MEMORY_DESCRIPTION,
    inputSchema: AppendSetupMemoryInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }
      const validation = validateSetupMemoryAppend(input.markdown);
      if (!validation.ok) {
        return toolError(validation.message);
      }
      const result = await host.setupStore.appendReadyProfileMemory({
        repo: resolved.repo,
        branch: resolved.branch,
        appendMarkdown: validation.value,
      });
      if (!result.ok) {
        return toolError(result.message);
      }
      return toolResult({
        status: "appended",
        revision: result.profile.revision,
      });
    },
  });
}
