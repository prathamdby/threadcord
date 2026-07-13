import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { defineResilientTool } from "../tools/resilient-tool.js";
import { formatToolValidationError } from "../tools/format-validation-error.js";
import * as v from "valibot";
import { getPool } from "../db.js";
import { validateSetupProfilePayload } from "./profile.js";
import { SetupStore } from "./store.js";
import { formatSetupVerifyError, verifySetupEnvironment } from "./verify.js";

export function createSetupTools(runId: string) {
  return [
    defineResilientTool({
      name: "save_threadcord_setup_profile",
      description:
        "Promote this setup workspace into a durable Threadcord setup profile. parameters: environment, memoryMarkdown. The tool re-runs install, every check, optional skills (from environment.skills, after install), and (if non-empty) a short smoke probe of start, all in the current setup workspace. Save only checks that already passed in this workspace; failing checks cause the entire save to be rejected and you must adjust and call again. Environment: install (required non-empty bash one-liner), start (optional smoke-probable command), checks (record of name -> bash one-liner, names match /^[a-zA-Z][a-zA-Z0-9_-]*$/), requiredEnv (UPPER_SNAKE names only, never values), requiredServices (string names), skills (optional array of skill repo URLs; not set by setup agent — use profile from wizard). memoryMarkdown is <=60000 chars, must not contain anything that looks like a secret value (keys, tokens, passwords), and should follow WRITING: concrete paths/commands/gotchas, no puffery. On success the setup workspace is removed.",
      parameters: v.object({
        environment: v.object({
          install: v.string(),
          start: v.optional(v.string()),
          checks: v.optional(v.record(v.string(), v.string())),
          requiredEnv: v.optional(v.array(v.string())),
          requiredServices: v.optional(v.array(v.string())),
          skills: v.optional(v.array(v.string())),
        }),
        memoryMarkdown: v.string(),
      }),
      async execute(input) {
        const parsed = validateSetupProfilePayload({
          environment: input.environment,
          memoryMarkdown: input.memoryMarkdown,
        });
        if (!parsed.ok) {
          throw new Error(
            formatToolValidationError({
              toolName: "save_threadcord_setup_profile",
              issues: [{ path: [], message: parsed.message }],
              requiredReminder:
                "Required: environment.install (non-empty), memoryMarkdown.",
            }),
          );
        }
        const store = new SetupStore(getPool());
        const run = await store.getRunByInstanceId(`setup:${runId}`);
        if (!run) {
          throw new Error("Setup run is missing.");
        }
        const checkoutDir = join(run.workspacePath, basename(run.repo));
        const profileBefore = await store.getProfileById(run.profileId);
        const environment = { ...parsed.value.environment };
        if (
          profileBefore?.environment.skills?.length &&
          !(environment.skills && environment.skills.length > 0)
        ) {
          environment.skills = profileBefore.environment.skills;
        }
        const verification = await verifySetupEnvironment({
          environment,
          workspaceRoot: run.workspacePath,
          checkoutDir,
          githubToken: process.env.GITHUB_TOKEN ?? "",
        });
        if (!verification.ok) {
          throw new Error(formatSetupVerifyError(verification));
        }
        const profile = await store.promoteRun({
          runId,
          environment,
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
