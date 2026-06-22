import { defineTool } from '@flue/runtime';
import { Octokit } from '@octokit/rest';
import * as v from 'valibot';
import { assertRepoAllowed } from '../task/policy.js';

export function createGitHubTools(token: string, allowedRepos: string[]) {
  const octokit = new Octokit({
    auth: token,
    userAgent: 'threadcord/0.1.0'
  });

  return [
    defineTool({
      name: 'create_github_pull_request',
      description: 'Create a GitHub pull request for the already-pushed task branch.',
      parameters: v.object({
        owner: v.pipe(v.string(), v.minLength(1)),
        repo: v.pipe(v.string(), v.minLength(1)),
        title: v.pipe(v.string(), v.minLength(1)),
        head: v.pipe(v.string(), v.minLength(1)),
        base: v.pipe(v.string(), v.minLength(1)),
        body: v.optional(v.string())
      }),
      async execute(input) {
        const fullRepo = `${input.owner}/${input.repo}`;
        assertRepoAllowed(fullRepo, allowedRepos);
        const payload = {
          owner: input.owner,
          repo: input.repo,
          title: input.title,
          head: input.head,
          base: input.base,
          ...(input.body ? { body: input.body } : {})
        };
        const response = await octokit.rest.pulls.create(payload);
        return JSON.stringify({
          number: response.data.number,
          url: response.data.html_url,
          state: response.data.state
        });
      }
    })
  ];
}
