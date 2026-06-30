import { z } from "zod";
import { hostTool } from "@rivet-dev/agentos-core";
import type { BindingsHost, HostTool, ToolOutput } from "./types.js";
import { toolResult, toolError } from "./types.js";

const CREATE_PULL_REQUEST_DESCRIPTION =
  "Open a GitHub pull request. Call only after the branch has been pushed successfully. Required: owner (GitHub org/user), repo (repo name only, no slash), title (plain English, <=72 chars), head (the pushed branch name; usually threadcord/<type>/<name>), base (the task base branch). Optional body (Markdown; group changes by area, link to relevant issues, do not paste GITHUB_TOKEN or env values). Returns { number, url, state }. Do not call twice for the same head/base; if a PR already exists, post its URL via post_thread_message instead.";

const CreateGitHubPullRequestInputSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  head: z.string().min(1),
  base: z.string().min(1),
  body: z.string().optional(),
});

export function createGitHubPullRequestTool(
  host: BindingsHost,
): HostTool<z.infer<typeof CreateGitHubPullRequestInputSchema>, ToolOutput> {
  return hostTool({
    description: CREATE_PULL_REQUEST_DESCRIPTION,
    inputSchema: CreateGitHubPullRequestInputSchema,
    async execute(input): Promise<ToolOutput> {
      const octokit = host.octokitFactory(host.githubToken);
      const payload = {
        owner: input.owner,
        repo: input.repo,
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body ? { body: input.body } : {}),
      };
      try {
        const response = await octokit.rest.pulls.create(payload);
        return toolResult({
          number: response.data.number,
          url: response.data.html_url,
          state: response.data.state,
        });
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : "Failed to create GitHub PR.",
        );
      }
    },
  });
}

export { CREATE_PULL_REQUEST_DESCRIPTION };
