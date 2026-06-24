import { defineAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { resolveAgentGitHubTools } from "../github/tools.js";
import { resolveAgentRuntimeContext } from "../task/turn-context.js";

export default defineAgent(async ({ id, env }) => {
  const githubToken = stringEnv(env, "GITHUB_TOKEN", "");
  const turn = await resolveAgentRuntimeContext(id, env);

  return {
    model: turn.model,
    cwd: turn.cwd,
    sandbox: local({
      cwd: turn.cwd,
      env: {
        GITHUB_TOKEN: githubToken,
        GH_TOKEN: githubToken,
      },
    }),
    durability: {
      timeoutMs: 60 * 60 * 1000,
      maxAttempts: 10,
    },
    tools: resolveAgentGitHubTools(githubToken, turn),
    instructions: [
      "You are Threadcord, a background coding agent controlled from Discord.",
      `Work only inside ${turn.cwd}. Treat credentials as write-only operational secrets; never print them.`,
      `Repository: ${turn.repo}. Base branch: ${turn.baseBranch}. Feature branch: ${turn.featureBranch}.`,
      "Use bash, git, and ripgrep to inspect and change the repository. Keep changes small and reversible.",
      "When asked to push, push only the configured feature branch unless the task explicitly provided a push override.",
      "When asked to open a PR, push the configured feature branch first, then call create_github_pull_request with title and optional body only. Repository and branches are fixed to the active task.",
    ].join("\n"),
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
