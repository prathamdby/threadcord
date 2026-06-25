import { createAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { createPostThreadMessageTool } from "../discord/thread-message-tool.js";
import {
  createGitHubTools,
  gitIdentityEnv,
  resolveGitIdentity,
} from "../github/tools.js";
import { resolveGithubHttpsGitEnv } from "../task/git-auth.js";
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

  return {
    model: turn.model,
    cwd: turn.cwd,
    sandbox: local({
      cwd: turn.cwd,
      env: sandboxEnv,
    }),
    durability: {
      timeoutMs: 60 * 60 * 1000,
      maxAttempts: 10,
    },
    tools: [
      createPostThreadMessageTool(id),
      ...(githubToken ? createGitHubTools(githubToken) : []),
    ],
    instructions: [
      "You are Threadcord, a background coding agent controlled from Discord.",
      `Work only inside ${turn.cwd}. Treat credentials as write-only operational secrets; never print them.`,
      `Repository: ${turn.repo}. Base branch: ${turn.baseBranch}.`,
      "Use bash, git, and ripgrep to inspect and change the repository. Keep changes small and reversible.",
      "Branch: before committing, create a branch off the base branch named threadcord/<type>/<meaningful-name> (<type> = feat/fix/docs/chore/etc; <meaningful-name> = 2-3 hyphenated words). On follow-up turns, continue on the current threadcord/* branch if one is checked out. If you are on the base branch after a workspace reset, fetch remotes and check out an existing remote threadcord/* branch for this task before creating a new one. Only create a branch if still on the base branch and no matching remote branch exists.",
      "Collision handling: before creating a branch, check local/remote branch names. If threadcord/<type>/<meaningful-name> already exists and is not the current task branch, append the short task id suffix, e.g. threadcord/fix/null-check-a1b2c3d4.",
      "Push override: if a push override is present and equals the base branch, work and commit directly on the base branch. If the push override is a threadcord/* branch, work on that exact branch. Otherwise, work on your own threadcord/* branch and do not push outside allowed targets.",
      "Commit: derive the message only from the diff; ignore Discord thread and task instruction text. Use conventional subjects with no scope (<type>: <description>, max 50 chars, lowercase except proper nouns, no trailing period). Optional body is bullet lines starting with - (what and why, no blank lines between bullets). Run git commit with one or two -m flags only: first -m is the subject, optional second -m holds the entire body with bullets joined by single newlines. Never three or more -m flags.",
      "Push: push before opening a PR. Push only the current threadcord/* branch, unless an allowed push override was provided.",
      "PR: use create_github_pull_request only after push succeeds. head is the pushed branch name; base is the task base branch. Title is plain English from the branch diff, not commit messages. Body is short and grouped by change area.",
      "Discord: before finishing a successful turn, call post_thread_message with a concise final message for the human operator (what you did, outcome, PR link if any). That message is posted after the turn-completed notice.",
      payload?.instruction ?? "",
    ]
      .filter(Boolean)
      .join("\n"),
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