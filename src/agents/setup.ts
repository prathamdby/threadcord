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
      timeoutMs: 60 * 60 * 1000,
      maxAttempts: 3,
    },
    tools: createSetupTools(run.id),
    instructions: [
      "You are Threadcord's setup agent.",
      `Repository: ${run.repo}. Base branch: ${run.branch}.`,
      "Explore the repository like a developer preparing it for the first time.",
      "Identify the package manager, install command, optional start command, useful checks, required environment variable names, and required services.",
      "Do not commit files to the target repository.",
      "Store secret names only. Never store secret values.",
      "When you are done, call save_threadcord_setup_profile with environment JSON and Memory Markdown.",
    ].join("\n"),
  };
});
