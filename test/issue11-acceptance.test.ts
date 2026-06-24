import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  bindingFromAgentRuntimeContext,
  createGitHubTools,
  resolveAgentGitHubTools,
  type CreatePullRequestPayload,
  type GitHubTaskBinding,
} from "../src/github/tools.js";
import { targetBranchForTask } from "../src/task/policy.js";
import type { AgentRuntimeContext } from "../src/task/turn-context.js";

const binding: GitHubTaskBinding = {
  owner: "acme",
  repo: "web",
  baseBranch: "main",
  featureBranch: "agent/task-1",
};

const runtimeContext: AgentRuntimeContext = {
  model: "anthropic/claude-sonnet-4-5",
  cwd: "/workspaces/task-1/web",
  repo: "acme/web",
  baseBranch: "main",
  featureBranch: "agent/task-1",
};

function prTool(token = "fake-token", deps = {}) {
  const [tool] = createGitHubTools(token, binding, deps);
  return tool!;
}

describe("issue #11 user stories", () => {
  it("story 1: PR tool constrained to active task repository", async () => {
    expect(bindingFromAgentRuntimeContext(runtimeContext)).toMatchObject({
      owner: "acme",
      repo: "web",
    });

    let captured: CreatePullRequestPayload | undefined;
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async (payload: CreatePullRequestPayload) => {
        captured = payload;
        return { number: 1, url: "https://github.com/acme/web/pull/1", state: "open" };
      },
    });

    await tool.run({ input: { title: "Feature" } });
    expect(captured?.owner).toBe("acme");
    expect(captured?.repo).toBe("web");
  });

  it("story 2: PR tool constrained to active task base branch", async () => {
    let captured: CreatePullRequestPayload | undefined;
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async (payload: CreatePullRequestPayload) => {
        captured = payload;
        return { number: 1, url: "https://github.com/acme/web/pull/1", state: "open" };
      },
    });

    await tool.run({ input: { title: "Feature" } });
    expect(captured?.base).toBe("main");
    expect(() =>
      v.parse(tool.input, { title: "x", base: "evil" } as never),
    ).toThrow();
  });

  it("story 3: PR tool constrained to active task feature branch", async () => {
    let captured: CreatePullRequestPayload | undefined;
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async (payload: CreatePullRequestPayload) => {
        captured = payload;
        return { number: 1, url: "https://github.com/acme/web/pull/1", state: "open" };
      },
    });

    await tool.run({ input: { title: "Feature" } });
    expect(captured?.head).toBe("agent/task-1");
    expect(() =>
      v.parse(tool.input, { title: "x", head: "evil" } as never),
    ).toThrow();
  });

  it("story 4: application narrows token authority at tool boundaries", () => {
    const tool = prTool();
    expect(() =>
      v.parse(tool.input, {
        owner: "evil",
        repo: "other",
        title: "Add feature",
        head: "malicious",
        base: "main",
      }),
    ).toThrow();
  });

  it("story 5: agent can still open PRs for completed work", async () => {
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async () => ({
        number: 7,
        url: "https://github.com/acme/web/pull/7",
        state: "open",
      }),
    });

    const result = await tool.run({ input: { title: "Add feature", body: "Done" } });
    expect(result).toEqual({
      number: 7,
      url: "https://github.com/acme/web/pull/7",
      state: "open",
    });
  });

  it("story 6: PR creation failures are clear for unpushed branch or GitHub rejection", async () => {
    const unpushed = prTool("fake-token", {
      isFeatureBranchPushed: async () => false,
      createPullRequest: async () => {
        throw new Error("createPullRequest should not be called");
      },
    });
    await expect(unpushed.run({ input: { title: "Feature" } })).rejects.toThrow(
      "Task branch agent/task-1 has not been pushed to acme/web",
    );

    const rejected = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async () => {
        throw new Error(
          "GitHub rejected the pull request: A pull request already exists for acme:agent/task-1.",
        );
      },
    });
    await expect(rejected.run({ input: { title: "Feature" } })).rejects.toThrow(
      "GitHub rejected the pull request",
    );
  });

  it("story 7: model chooses title and body only", () => {
    const tool = prTool();
    const parsed = v.parse(tool.input, { title: "Add feature", body: "Details" });
    expect(Object.keys(parsed)).toEqual(["title", "body"]);
  });

  it("story 8: prompt injection cannot change the PR target", async () => {
    const tool = prTool();
    expect(() =>
      v.parse(tool.input, {
        owner: "injected",
        repo: "repo",
        title: "x",
        head: "branch",
        base: "main",
      }),
    ).toThrow();

    let captured: CreatePullRequestPayload | undefined;
    const boundTool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async (payload: CreatePullRequestPayload) => {
        captured = payload;
        return { number: 1, url: "https://github.com/acme/web/pull/1", state: "open" };
      },
    });
    await boundTool.run({ input: { title: "Feature" } });
    expect(captured).toMatchObject({
      owner: "acme",
      repo: "web",
      head: "agent/task-1",
      base: "main",
    });
  });

  it("story 9: tool description states task-bound behavior", () => {
    const tool = prTool();
    expect(tool.description).toContain(
      "Repository, base branch, and feature branch are fixed to the task",
    );
    expect(tool.description).toContain("title and optional body only");
  });

  it("story 10: task context passed into tool creation at agent initialization", () => {
    const tools = resolveAgentGitHubTools("fake-token", runtimeContext);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("create_github_pull_request");
  });

  it("story 11: tool fails closed when task context is missing", () => {
    expect(() =>
      bindingFromAgentRuntimeContext({ ...runtimeContext, repo: "invalid" }),
    ).toThrow("Invalid task repository for GitHub PR tool");
    expect(() =>
      bindingFromAgentRuntimeContext({ ...runtimeContext, featureBranch: "" }),
    ).toThrow("Task branch context is missing");
    expect(resolveAgentGitHubTools("", runtimeContext)).toEqual([]);
    expect(() =>
      resolveAgentGitHubTools("fake-token", { ...runtimeContext, repo: "bad" }),
    ).toThrow("Invalid task repository for GitHub PR tool");
  });

  it("story 12: tool result stays structured and concise", async () => {
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async () => ({
        number: 9,
        url: "https://github.com/acme/web/pull/9",
        state: "open",
      }),
    });
    const result = await tool.run({ input: { title: "Feature" } });
    const parsed = v.parse(tool.output, result);
    expect(Object.keys(parsed)).toEqual(["number", "url", "state"]);
  });

  it("story 13: tests prove input cannot change repository or branch", () => {
    const tool = prTool();
    expect(() =>
      v.parse(tool.input, {
        owner: "evil",
        repo: "other",
        title: "x",
        head: "malicious",
        base: "main",
      }),
    ).toThrow();
    expect(bindingFromAgentRuntimeContext(runtimeContext)).toEqual(binding);
  });

  it("story 14: push override policy respected via task feature branch", () => {
    const overrideBranch = targetBranchForTask("task-1", {
      instruction: "push to main",
      repo: "acme/web",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      pushOverride: "main",
    });
    expect(overrideBranch).toBe("main");
    expect(
      bindingFromAgentRuntimeContext({
        ...runtimeContext,
        featureBranch: overrideBranch,
      }).featureBranch,
    ).toBe("main");
  });

  it("story 15: GitHub tool contract is obviously task-scoped", () => {
    const source = readFileSync("src/github/tools.ts", "utf8");
    expect(source).toContain("export interface GitHubTaskBinding");
    expect(source).toContain("export function bindingFromAgentRuntimeContext");
    expect(source).toContain("export function resolveAgentGitHubTools");
  });

  it("story 16: no regression in happy path after pushing configured branch", async () => {
    let captured: CreatePullRequestPayload | undefined;
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async (payload: CreatePullRequestPayload) => {
        captured = payload;
        return { number: 7, url: "https://github.com/acme/web/pull/7", state: "open" };
      },
    });

    const result = await tool.run({
      input: { title: "Add feature", body: "Summary" },
    });

    expect(captured).toEqual({
      owner: "acme",
      repo: "web",
      title: "Add feature",
      head: "agent/task-1",
      base: "main",
      body: "Summary",
    });
    expect(result.state).toBe("open");
  });
});

describe("issue #11 implementation decisions", () => {
  it("impl: createGitHubTools receives task binding from application context", () => {
    expect(() => createGitHubTools("fake-token", binding)).not.toThrow();
  });

  it("impl: owner, repository, head, and base removed from model input", () => {
    const tool = prTool();
    const keys = Object.keys(
      v.parse(tool.input, { title: "x" }) as Record<string, unknown>,
    );
    expect(keys).toEqual(["title"]);
  });

  it("impl: title and body remain model-controlled inputs", () => {
    const tool = prTool();
    expect(v.parse(tool.input, { title: "Title", body: "Body" })).toEqual({
      title: "Title",
      body: "Body",
    });
  });

  it("impl: execution validates binding and branch push before create", async () => {
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => false,
      createPullRequest: async () => {
        throw new Error("should not run");
      },
    });
    await expect(tool.run({ input: { title: "x" } })).rejects.toThrow(
      "has not been pushed",
    );
  });

  it("impl: feature branch is PR head and base branch is PR base", async () => {
    let captured: CreatePullRequestPayload | undefined;
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async (payload: CreatePullRequestPayload) => {
        captured = payload;
        return { number: 1, url: "https://github.com/acme/web/pull/1", state: "open" };
      },
    });
    await tool.run({ input: { title: "x" } });
    expect(captured?.head).toBe(binding.featureBranch);
    expect(captured?.base).toBe(binding.baseBranch);
  });

  it("impl: returns structured PR metadata only", async () => {
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async () => ({
        number: 3,
        url: "https://github.com/acme/web/pull/3",
        state: "open",
      }),
    });
    const result = await tool.run({ input: { title: "x" } });
    expect(result).toEqual({
      number: 3,
      url: "https://github.com/acme/web/pull/3",
      state: "open",
    });
  });

  it("impl: agent instructions describe task-bound PR tool", () => {
    const instructions = readFileSync("src/agents/coding.ts", "utf8");
    expect(instructions).toContain("title and optional body only");
    expect(instructions).toContain("Repository and branches are fixed to the active task");
  });

  it("impl: agent instructions require pushing before PR creation", () => {
    const instructions = readFileSync("src/agents/coding.ts", "utf8");
    expect(instructions).toContain("push the configured feature branch first");
  });

  it("impl: no new GitHub token scopes or operations added", () => {
    const source = readFileSync("src/github/tools.ts", "utf8");
    expect(source).not.toMatch(/issues\.create/);
    expect(source).not.toMatch(/repos\.create/);
  });
});

describe("issue #11 testing decisions", () => {
  it("testing: injectable createPullRequest and isFeatureBranchPushed seams", async () => {
    let pushed = false;
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => pushed,
      createPullRequest: async () => ({
        number: 1,
        url: "https://github.com/acme/web/pull/1",
        state: "open",
      }),
    });
    await expect(tool.run({ input: { title: "x" } })).rejects.toThrow();
    pushed = true;
    await expect(tool.run({ input: { title: "x" } })).resolves.toBeDefined();
  });

  it("testing: input schema accepts title and optional body only", () => {
    const tool = prTool();
    expect(Object.keys(v.parse(tool.input, { title: "x" }))).toEqual(["title"]);
  });

  it("testing: repository and branches derived from task context", () => {
    expect(bindingFromAgentRuntimeContext(runtimeContext)).toEqual(binding);
  });

  it("testing: missing task context fails closed", () => {
    expect(() => createGitHubTools("fake-token", { ...binding, repo: "" })).toThrow(
      "GitHub task binding is missing repo",
    );
  });

  it("testing: successful execution uses task repository and branches", async () => {
    let captured: CreatePullRequestPayload | undefined;
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async (payload: CreatePullRequestPayload) => {
        captured = payload;
        return { number: 1, url: "https://github.com/acme/web/pull/1", state: "open" };
      },
    });
    await tool.run({ input: { title: "x" } });
    expect(captured).toMatchObject({
      owner: "acme",
      repo: "web",
      head: "agent/task-1",
      base: "main",
    });
  });

  it("testing: output contains only safe PR metadata", async () => {
    const tool = prTool("fake-token", {
      isFeatureBranchPushed: async () => true,
      createPullRequest: async () => ({
        number: 2,
        url: "https://github.com/acme/web/pull/2",
        state: "open",
      }),
    });
    const result = await tool.run({ input: { title: "x" } });
    expect(Object.keys(result)).toEqual(["number", "url", "state"]);
  });

  it("testing: agent initialization seam via resolveAgentGitHubTools", () => {
    expect(resolveAgentGitHubTools("fake-token", runtimeContext)[0]?.name).toBe(
      "create_github_pull_request",
    );
  });

  it("testing: assertions avoid Octokit internals", () => {
    const tests = readFileSync("test/github-tools.test.ts", "utf8");
    expect(tests).not.toMatch(/octokit\.rest/);
  });
});