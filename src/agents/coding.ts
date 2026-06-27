import { createAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { getRuntimeConfig } from "../config.js";
import { codingAgentDurability } from "../flue/agent-guardrails.js";
import { getMcpTools } from "../flue/mcp.js";
import { createThreadMessageTools } from "../discord/thread-message-tool.js";
import { createSetupMemoryTools } from "../setup/memory-tools.js";
import {
  createGitHubTools,
  gitIdentityEnv,
  resolveGitIdentity,
} from "../github/tools.js";
import { resolveGithubHttpsGitEnv } from "../task/git-auth.js";
import { composePrompt } from "./prompts/compose.js";
import { resolveAgentRuntimeContext } from "../task/turn-context.js";
import { workspaceEnv } from "../task/workspace-env.js";
import type { DispatchAgentInput } from "../types.js";

export default createAgent<DispatchAgentInput>(async ({ id, env, payload }) => {
  const githubToken = stringEnv(env, "GITHUB_TOKEN", "");
  const turn = await resolveAgentRuntimeContext(id, env);
  const gitIdentity = githubToken
    ? await resolveGitIdentity(githubToken)
    : undefined;

  const sandboxEnv = githubToken
    ? await resolveGithubHttpsGitEnv(
        turn.workspaceRoot,
        githubToken,
        gitIdentity ? gitIdentityEnv(gitIdentity) : {},
      )
    : workspaceEnv(turn.workspaceRoot);

  const mcpTools = await getMcpTools();

  return {
    model: turn.model,
    cwd: turn.cwd,
    sandbox: local({
      cwd: turn.cwd,
      env: sandboxEnv,
    }),
    durability: codingAgentDurability(getRuntimeConfig()),
    tools: [
      ...createThreadMessageTools(id),
      ...createSetupMemoryTools(turn.repo, turn.baseBranch),
      ...(githubToken ? createGitHubTools(githubToken) : []),
      ...mcpTools,
    ],
    instructions: composePrompt({
      role: "coding",
      ctx: {
        cwd: turn.cwd,
        repo: turn.repo,
        baseBranch: turn.baseBranch,
        ...(turn.pushOverride ? { pushOverride: turn.pushOverride } : {}),
        checks: turn.checks,
        requiredEnv: turn.requiredEnv,
        instruction: payload?.instruction ?? "",
      },
    }),
  };
});

function stringEnv(
  env: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
