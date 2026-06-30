import { z } from "zod";
import { hostTool } from "@rivet-dev/agentos-core";
import { resolveGithubHttpsGitEnv } from "../task/git-auth.js";
import type { BindingsHost, HostTool, ToolOutput } from "./types.js";
import { toolResult, toolError } from "./types.js";

const GIT_PUSH_DESCRIPTION =
  "Push the current branch to origin. Allowed targets are the task base branch and any threadcord/* branch. The server-side GitHub PAT is used by the host; it is never exposed to the guest environment. Call git_commit first if there are uncommitted changes. Do not force-push.";

const GitPushInputSchema = z.object({
  instanceId: z.string().min(1),
  branch: z.string().min(1),
  force: z.boolean().optional(),
});

export function createGitPushTool(
  host: BindingsHost,
): HostTool<z.infer<typeof GitPushInputSchema>, ToolOutput> {
  return hostTool({
    description: GIT_PUSH_DESCRIPTION,
    inputSchema: GitPushInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }
      if (!isAllowedPushBranch(input.branch, resolved.branch)) {
        return toolError(
          `Push target '${input.branch}' is not allowed. Allowed targets are the base branch '${resolved.branch}' and threadcord/* branches.`,
        );
      }
      if (input.force) {
        return toolError("Force-push is not allowed.");
      }
      const env = await resolveGithubHttpsGitEnv(
        resolved.workspacePath,
        host.githubToken,
      );
      const result = await host.gitExecutor.run(
        ["push", "origin", input.branch],
        resolved.workspacePath,
        env,
      );
      if (result.exitCode !== 0) {
        const message = [result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n");
        return toolError(message || "Git push failed.");
      }
      return toolResult(`Pushed ${input.branch} to origin.`);
    },
  });
}

export function isAllowedPushBranch(
  target: string,
  baseBranch: string,
): boolean {
  if (target === baseBranch) return true;
  if (target.startsWith("threadcord/")) return true;
  return false;
}

export { GIT_PUSH_DESCRIPTION };
