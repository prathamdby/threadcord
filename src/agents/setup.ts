import { basename, join } from "node:path";
import { createAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { getPool } from "../db.js";
import { createSetupTools } from "../setup/tools.js";
import { SetupStore } from "../setup/store.js";
import { workspaceEnv } from "../task/workspace-env.js";

export default createAgent(async ({ id }) => {
  const store = new SetupStore(getPool());
  const run = await store.getRunByInstanceId(id);
  if (!run) throw new Error(`No Threadcord setup run found for ${id}`);
  const checkoutPath = join(run.workspacePath, basename(run.repo));

  return {
    model: run.model,
    cwd: checkoutPath,
    sandbox: local({
      cwd: checkoutPath,
      env: workspaceEnv(run.workspacePath, {
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
        GH_TOKEN: process.env.GITHUB_TOKEN ?? "",
      }),
    }),
    durability: {
      timeoutMs: 30 * 60 * 1000,
      maxAttempts: 3,
    },
    tools: createSetupTools(run.id),
    instructions: [
      "You are Threadcord's setup agent.",
      `Repository: ${run.repo}. Base branch: ${run.branch}.`,
      "Explore the repository like a developer preparing it for the first time.",
      "Identify the package manager, install command, optional start command, useful checks, required environment variable names, and required services.",
      "Run the proposed install command in the checkout before saving.",
      "Run every proposed check command in the checkout before saving.",
      "Save only checks that passed in this clean setup workspace.",
      "If a useful command requires missing secrets or services, record those names in requiredEnv, requiredServices, and memory instead of saving a failing check.",
      "start is optional. If present, choose a command that can be smoke-probed. The save tool rejects a start command that exits non-zero immediately.",
      "The save tool re-runs install and checks before promotion. If it rejects the profile, inspect the output, adjust the commands, and call the tool again.",
      "Do not commit files to the target repository.",
      "Store secret names only. Never store secret values.",
      "When you are done, call save_threadcord_setup_profile with environment JSON and Memory Markdown.",
    ].join("\n"),
  };
});
