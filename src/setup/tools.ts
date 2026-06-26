import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { getPool } from "../db.js";
import { validateSetupProfilePayload } from "./profile.js";
import { SetupStore } from "./store.js";
import { formatSetupVerifyError, verifySetupEnvironment } from "./verify.js";

export function createSetupTools(runId: string) {
  return [
    defineTool({
      name: "save_threadcord_setup_profile",
      description:
        "Promote this setup workspace into a durable Threadcord setup profile. The tool re-runs install, every check, and (if non-empty) a short smoke probe of start, all in the current setup workspace. Save only checks that already passed in this workspace; failing checks cause the entire save to be rejected and you must adjust and call again. Environment: install (required non-empty bash one-liner), start (optional smoke-probable command), checks (record of name -> bash one-liner, names match /^[a-zA-Z][a-zA-Z0-9_-]*$/), requiredEnv (UPPER_SNAKE names only, never values), requiredServices (string names). memoryMarkdown is <=60000 chars and must not contain anything that looks like a secret value (keys, tokens, passwords). On success the setup workspace is removed.",
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
        if (!run) {
          throw new Error("Setup run is missing.");
        }
        const checkoutDir = join(run.workspacePath, basename(run.repo));
        const verification = await verifySetupEnvironment({
          environment: parsed.value.environment,
          workspaceRoot: run.workspacePath,
          checkoutDir,
          githubToken: process.env.GITHUB_TOKEN ?? "",
        });
        if (!verification.ok) {
          // Keep workspace so the setup agent can adjust commands and retry save.
          throw new Error(formatSetupVerifyError(verification));
        }
        const profile = await store.promoteRun({
          runId,
          environment: parsed.value.environment,
          memoryMarkdown: parsed.value.memoryMarkdown,
        });
        await rm(run.workspacePath, { recursive: true, force: true }).catch(
          (error) => {
            console.warn(
              `[threadcord] Failed to remove setup workspace ${run.workspacePath}`,
              error,
            );
          },
        );
        return JSON.stringify({
          status: "saved",
          profileId: profile.id,
          revision: profile.revision,
        });
      },
    }),
  ];
}
