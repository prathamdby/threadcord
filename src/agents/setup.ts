import { basename, join } from "node:path";
import { createAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { getRuntimeConfig } from "../config.js";
import { setupAgentDurability } from "../flue/agent-guardrails.js";
import { getPool } from "../db.js";
import { createSetupTools } from "../setup/tools.js";
import { SetupStore } from "../setup/store.js";
import { resolveGithubHttpsGitEnv } from "../task/git-auth.js";
import { composePrompt } from "./prompts/compose.js";

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
    durability: setupAgentDurability(getRuntimeConfig()),
    tools: createSetupTools(run.id),
    instructions: composePrompt({
      role: "setup",
      ctx: {
        repo: run.repo,
        branch: run.branch,
      },
    }),
  };
});
