import { rm } from "node:fs/promises";
import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { getPool } from "../db.js";
import { validateSetupProfilePayload } from "./profile.js";
import { SetupStore } from "./store.js";

export function createSetupTools(runId: string) {
  return [
    defineTool({
      name: "save_threadcord_setup_profile",
      description:
        "Validate and save the durable Threadcord setup profile discovered for this repository.",
      parameters: v.object({
        environment: v.object({
          install: v.string(),
          start: v.optional(v.string()),
          checks: v.optional(v.record(v.string(), v.string())),
          requiredEnv: v.optional(v.array(v.string())),
          requiredServices: v.optional(v.array(v.string())),
        }),
        memoryMarkdown: v.string(),
      }),
      async execute(input) {
        const parsed = validateSetupProfilePayload({
          environment: input.environment,
          memoryMarkdown: input.memoryMarkdown,
        });
        if (!parsed.ok) {
          throw new Error(parsed.message);
        }
        const store = new SetupStore(getPool());
        const run = await store.getRunByInstanceId(`setup:${runId}`);
        const profile = await store.promoteRun({
          runId,
          environment: parsed.value.environment,
          memoryMarkdown: parsed.value.memoryMarkdown,
        });
        if (run) {
          await rm(run.workspacePath, { recursive: true, force: true });
        }
        return JSON.stringify({
          status: "saved",
          profileId: profile.id,
          revision: profile.revision,
        });
      },
    }),
  ];
}
