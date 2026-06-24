import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  assertGitHubTaskBinding,
  bindingFromAgentRuntimeContext,
  createGitHubTools,
  type CreatePullRequestPayload,
  type GitHubTaskBinding,
} from "../src/github/tools.js";
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

describe("bindingFromAgentRuntimeContext", () => {
  it("derives owner, repo, and branches from task context", () => {
    expect(bindingFromAgentRuntimeContext(runtimeContext)).toEqual(binding);
  });

  it("fails closed when repository format is invalid", () => {
    expect(() =>
      bindingFromAgentRuntimeContext({ ...runtimeContext, repo: "not-valid" }),
    ).toThrow("Invalid task repository for GitHub PR tool");
  });

  it("fails closed when branch context is missing", () => {
    expect(() =>
      bindingFromAgentRuntimeContext({ ...runtimeContext, featureBranch: "" }),
    ).toThrow("Task branch context is missing");
  });
});

describe("assertGitHubTaskBinding", () => {
  it("returns the binding when all fields are present", () => {
    expect(assertGitHubTaskBinding(binding)).toEqual(binding);
  });

  it("fails closed when a bound field is empty", () => {
    expect(() =>
      assertGitHubTaskBinding({ ...binding, owner: "" }),
    ).toThrow("GitHub task binding is missing owner");
  });
});

describe("createGitHubTools", () => {
  it("exposes the create-pull-request tool", () => {
    const [tool] = createGitHubTools("fake-token", binding);
    expect(createGitHubTools("fake-token", binding)).toHaveLength(1);
    expect(tool?.name).toBe("create_github_pull_request");
    expect(typeof tool?.run).toBe("function");
  });

  it("fails closed when task binding is missing", () => {
    expect(() =>
      createGitHubTools("fake-token", { ...binding, repo: "" }),
    ).toThrow("GitHub task binding is missing repo");
  });

  it("uses the current input/run tool shape, not legacy parameters/execute", () => {
    const [tool] = createGitHubTools("fake-token", binding);
    expect(tool).toHaveProperty("input");
    expect(tool).not.toHaveProperty("parameters");
    expect(tool).not.toHaveProperty("execute");
  });

  it("accepts title and optional body only", () => {
    const [tool] = createGitHubTools("fake-token", binding);
    const parsed = v.parse(tool!.input, {
      title: "Add feature",
      body: "Details",
    });
    expect(parsed.title).toBe("Add feature");
    expect(parsed.body).toBe("Details");
    expect(Object.keys(parsed)).toEqual(["title", "body"]);
  });

  it("rejects model-controlled repository or branch fields", () => {
    const [tool] = createGitHubTools("fake-token", binding);
    expect(() =>
      v.parse(tool!.input, {
        owner: "evil",
        repo: "other",
        title: "Add feature",
        head: "malicious",
        base: "main",
      }),
    ).toThrow();
  });

  it("rejects an empty title", () => {
    const [tool] = createGitHubTools("fake-token", binding);
    expect(() => v.parse(tool!.input, { title: "" })).toThrow();
  });

  it("calls GitHub with task-bound repository and branches", async () => {
    let captured: CreatePullRequestPayload | undefined;
    const [tool] = createGitHubTools("fake-token", binding, {
      createPullRequest: async (payload) => {
        captured = payload;
        return {
          number: 7,
          url: "https://github.com/acme/web/pull/7",
          state: "open",
        };
      },
    });

    const result = await tool!.run({
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
    expect(result).toEqual({
      number: 7,
      url: "https://github.com/acme/web/pull/7",
      state: "open",
    });
  });

  it("returns only safe PR metadata", async () => {
    const [tool] = createGitHubTools("fake-token", binding, {
      createPullRequest: async () => ({
        number: 9,
        url: "https://github.com/acme/web/pull/9",
        state: "open",
      }),
    });

    const result = await tool!.run({ input: { title: "Add feature" } });
    const parsed = v.parse(tool!.output, result);
    expect(parsed).toEqual({
      number: 9,
      url: "https://github.com/acme/web/pull/9",
      state: "open",
    });
    expect(Object.keys(parsed)).toEqual(["number", "url", "state"]);
  });
});