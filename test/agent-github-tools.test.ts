import { describe, expect, it } from "vitest";
import { resolveAgentGitHubTools } from "../src/github/tools.js";
import type { AgentRuntimeContext } from "../src/task/turn-context.js";

const runtimeContext: AgentRuntimeContext = {
  model: "anthropic/claude-sonnet-4-5",
  cwd: "/workspaces/task-1/web",
  repo: "acme/web",
  baseBranch: "main",
  featureBranch: "agent/task-1",
};

describe("resolveAgentGitHubTools", () => {
  it("registers no tools when the GitHub token is missing", () => {
    expect(resolveAgentGitHubTools("", runtimeContext)).toEqual([]);
  });

  it("registers the task-bound PR tool when token and context are present", () => {
    const tools = resolveAgentGitHubTools("fake-token", runtimeContext);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("create_github_pull_request");
  });

  it("fails closed when task context cannot produce a binding", () => {
    expect(() =>
      resolveAgentGitHubTools("fake-token", {
        ...runtimeContext,
        repo: "invalid-repo",
      }),
    ).toThrow("Invalid task repository for GitHub PR tool");
  });
});