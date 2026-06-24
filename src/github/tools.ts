import { defineTool } from "@flue/runtime";
import { Octokit } from "@octokit/rest";
import * as v from "valibot";
import { parseGitHubRepository } from "../task/policy.js";
import type { AgentRuntimeContext } from "../task/turn-context.js";

export interface GitHubTaskBinding {
  owner: string;
  repo: string;
  baseBranch: string;
  featureBranch: string;
}

export type CreatePullRequestPayload = {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
};

export type CreatePullRequest = (
  payload: CreatePullRequestPayload,
) => Promise<{ number: number; url: string; state: string }>;

export interface GitHubToolsDeps {
  createPullRequest?: CreatePullRequest;
}

export function bindingFromAgentRuntimeContext(
  context: AgentRuntimeContext,
): GitHubTaskBinding {
  const parsed = parseGitHubRepository(context.repo);
  if (!parsed.ok) {
    throw new Error(
      `Invalid task repository for GitHub PR tool: ${context.repo}`,
    );
  }
  if (!context.baseBranch || !context.featureBranch) {
    throw new Error("Task branch context is missing for GitHub PR tool.");
  }
  return {
    owner: parsed.owner,
    repo: parsed.name,
    baseBranch: context.baseBranch,
    featureBranch: context.featureBranch,
  };
}

export function assertGitHubTaskBinding(
  binding: GitHubTaskBinding,
): GitHubTaskBinding {
  for (const [field, value] of Object.entries(binding)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`GitHub task binding is missing ${field}.`);
    }
  }
  return binding;
}

export function createGitHubTools(
  token: string,
  binding: GitHubTaskBinding,
  deps: GitHubToolsDeps = {},
) {
  const bound = assertGitHubTaskBinding(binding);
  const octokit = new Octokit({
    auth: token,
    userAgent: "threadcord/0.1.0",
  });
  const createPullRequest =
    deps.createPullRequest ??
    (async (payload) => {
      const response = await octokit.rest.pulls.create(payload);
      return {
        number: response.data.number,
        url: response.data.html_url,
        state: response.data.state,
      };
    });

  return [
    defineTool({
      name: "create_github_pull_request",
      description:
        "Create a GitHub pull request for the active task. Repository, base branch, and feature branch are fixed to the task. Provide title and optional body only.",
      input: v.strictObject({
        title: v.pipe(v.string(), v.minLength(1)),
        body: v.optional(v.string()),
      }),
      output: v.object({
        number: v.number(),
        url: v.string(),
        state: v.string(),
      }),
      async run({ input }) {
        return createPullRequest({
          owner: bound.owner,
          repo: bound.repo,
          title: input.title,
          head: bound.featureBranch,
          base: bound.baseBranch,
          ...(input.body ? { body: input.body } : {}),
        });
      },
    }),
  ];
}