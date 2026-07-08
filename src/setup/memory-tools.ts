import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { getPool } from "../db.js";
import { SETUP_MEMORY_APPEND_MAX_CHARS } from "./profile.js";
import { SetupStore } from "./store.js";

export const APPEND_THREADCORD_SETUP_MEMORY_DESCRIPTION =
  "Append durable Markdown to the setup profile memory for this task's repository and base branch. Single parameter `markdown` (string). Future coding turns load the updated block under Setup profile memory. Does not change install, checks, or environment JSON. Append only after you verified a fix or learned a stable repo fact worth repeating (gotchas, test quirks, operator prefs, non-obvious paths). One short paragraph or bullet list per call; <=4000 chars; names only for env vars; no secret values. On success increments profile revision; new tasks pick up the revision automatically, in-flight tasks keep their admitted revision until the next turn.";

export function createSetupMemoryTools(repo: string, branch: string) {
  return [
    defineTool({
      name: "append_threadcord_setup_memory",
      description: APPEND_THREADCORD_SETUP_MEMORY_DESCRIPTION,
      parameters: v.object({
        markdown: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(
            SETUP_MEMORY_APPEND_MAX_CHARS,
            `markdown exceeds ${SETUP_MEMORY_APPEND_MAX_CHARS} chars; split across turns`,
          ),
        ),
      }),
      async execute(input) {
        const store = new SetupStore(getPool());
        const result = await store.appendReadyProfileMemory({
          repo,
          branch,
          appendMarkdown: input.markdown,
        });
        if (!result.ok) {
          throw new Error(result.message);
        }
        return JSON.stringify({
          status: "appended",
          revision: result.profile.revision,
        });
      },
    }),
  ];
}
