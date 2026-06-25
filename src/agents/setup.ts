import { basename, join } from "node:path";
import { createAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { getPool } from "../db.js";
import { createSetupTools } from "../setup/tools.js";
import { SetupStore } from "../setup/store.js";
import { resolveGithubHttpsGitEnv } from "../task/git-auth.js";

export default createAgent(async ({ id }) => {
  const store = new SetupStore(getPool());
  const run = await store.getRunByInstanceId(id);
  if (!run) throw new Error(`No Threadcord setup run found for ${id}`);
  const checkoutPath = join(run.workspacePath, basename(run.repo));

  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const sandboxEnv = await resolveGithubHttpsGitEnv(
    run.workspacePath,
    githubToken,
  );

  return {
    model: run.model,
    cwd: checkoutPath,
    sandbox: local({
      cwd: checkoutPath,
      env: sandboxEnv,
    }),
    durability: {
      timeoutMs: 30 * 60 * 1000,
      maxAttempts: 3,
    },
    tools: createSetupTools(run.id),
    instructions: [
      "You are Threadcord's setup agent.",
      `Repository: ${run.repo}. Base branch: ${run.branch}.`,
      "Do not explore the repository deeply. Start with critical paths only: root README, package manifests and lockfiles, docker-compose or similar service definitions, and the main app entry or build config.",
      "From those, identify the package manager, install command, optional start command, useful checks, required environment variable names, and required services.",
      "Write the setup profile next: run the proposed install and checks in the checkout, then save. Prefer a short, accurate profile over exhaustive codebase reading.",
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
