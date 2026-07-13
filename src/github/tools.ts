import { createHash } from "node:crypto";
import { defineResilientTool } from "../tools/resilient-tool.js";
import { Octokit } from "@octokit/rest";
import type { RestEndpointMethodTypes } from "@octokit/rest";
import * as v from "valibot";

export interface GitIdentity {
  name: string;
  email: string;
}

type AuthenticatedUser =
  RestEndpointMethodTypes["users"]["getAuthenticated"]["response"]["data"];

const identityCache = new Map<string, GitIdentity>();

function identityCacheKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function gitIdentityFrom(user: AuthenticatedUser): GitIdentity {
  const name = user.name || user.login;
  const email =
    user.email ?? `${user.id}+${user.login}@users.noreply.github.com`;
  return { name, email };
}

export async function resolveGitIdentity(
  token: string,
): Promise<GitIdentity | undefined> {
  const cacheKey = identityCacheKey(token);
  const cached = identityCache.get(cacheKey);
  if (cached) return cached;

  try {
    const octokit = new Octokit({
      auth: token,
      userAgent: "threadcord/0.1.0",
    });
    const { data } = await octokit.rest.users.getAuthenticated();
    const identity = gitIdentityFrom(data);
    identityCache.set(cacheKey, identity);
    return identity;
  } catch (error) {
    console.warn(
      "Failed to resolve git identity from GitHub token:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

export function gitIdentityEnv(identity: GitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

export function createGitHubTools(token: string) {
  const octokit = new Octokit({
    auth: token,
    userAgent: "threadcord/0.1.0",
  });

  return [
    defineResilientTool({
      name: "create_github_pull_request",
      description:
        "Open a GitHub pull request. Call only after the branch was already-pushed successfully. Required: owner (GitHub org/user), repo (repo name only, no slash), title (plain English derived from the branch diff, not commit messages, <=72 chars), head (the pushed branch name; usually threadcord/<type>/<name>), base (the task base branch). Optional body (Markdown; group changes by area, link to relevant issues, do not paste GITHUB_TOKEN or env values). Title and body follow WRITING: plain speech, no AI vocab/filler, no em dashes, sentence-case section headings, concrete file/behavior facts. Returns JSON with the PR number, URL, and state. Do not call twice for the same head/base; if a PR already exists, post its URL via post_thread_message instead.",
      parameters: v.object({
        owner: v.pipe(v.string(), v.minLength(1)),
        repo: v.pipe(v.string(), v.minLength(1)),
        title: v.pipe(v.string(), v.minLength(1)),
        head: v.pipe(v.string(), v.minLength(1)),
        base: v.pipe(v.string(), v.minLength(1)),
        body: v.optional(v.string()),
      }),
      async execute(input) {
        const payload = {
          owner: input.owner,
          repo: input.repo,
          title: input.title,
          head: input.head,
          base: input.base,
          ...(input.body ? { body: input.body } : {}),
        };
        const response = await octokit.rest.pulls.create(payload);
        return JSON.stringify({
          number: response.data.number,
          url: response.data.html_url,
          state: response.data.state,
        });
      },
    }),
  ];
}
