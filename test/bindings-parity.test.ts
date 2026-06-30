import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BindingsHost,
  GitExecutor,
  HostTool,
  InstanceResolver,
  OctokitFactory,
  ResolvedInstance,
  ToolOutput,
} from "../src/bindings/types.js";
import type { EnvironmentIssue } from "../src/agentturn/machine-environment.js";
import {
  createPostThreadMessageTool,
  createPostThreadReportTool,
} from "../src/bindings/discord-post.js";
import { createEditThreadMessageTool } from "../src/bindings/discord-edit.js";
import { createGitHubPullRequestTool } from "../src/bindings/github.js";
import { createGitPushTool } from "../src/bindings/git-push.js";
import { createAppendSetupMemoryTool } from "../src/bindings/setup-memory.js";
import {
  createReportEnvironmentIssueTool,
  createRequestMissingSecretTool,
  createRequestNetworkAccessTool,
} from "../src/bindings/environment.js";
import {
  createProposeSetupProfileChangeTool,
  createRecordSetupMemoryTool,
  createSaveThreadcordSetupProfileTool,
} from "../src/bindings/setup-profile.js";
import {
  clearPendingUserTurnMessage,
  takePendingUserTurnMessages,
} from "../src/discord/user-turn-message.js";

let testWorkspacePath = "/workspaces/task-1";

const TASK_INSTANCE: ResolvedInstance = {
  instanceId: "discord:thread:task-1",
  threadId: "thread-1",
  get workspacePath() {
    return testWorkspacePath;
  },
  repo: "acme/web",
  branch: "main",
  taskId: "task-1",
  progressMessageId: "status-1",
};

const SETUP_INSTANCE: ResolvedInstance = {
  instanceId: "setup:run-1",
  threadId: "setup-thread-1",
  get workspacePath() {
    return testWorkspacePath;
  },
  repo: "acme/web",
  branch: "main",
  setupRunId: "run-1",
  progressMessageId: "setup-status-1",
};

const VALID_MESSAGE = [
  "## Summary",
  "Fixed the login redirect loop in auth.ts by moving the token check after the session setter.",
].join("\n");

function createFakeBindingsHost(): BindingsHost & {
  posts: { threadId: string; content: string }[];
  edits: { threadId: string; messageId: string; content: string }[];
  issues: EnvironmentIssue[];
  gitExecutorRuns: { command: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
  setupMemoryAppends: { repo: string; branch: string; appendMarkdown: string }[];
  setupDrafts: { id: string; profileId: string; environment: any; memoryMarkdown: string }[];
} {
  return {
    posts: [],
    edits: [],
    issues: [],
    gitExecutorRuns: [],
    setupMemoryAppends: [],
    setupDrafts: [],
    discordUserId: "threadcord-bot",
    instanceResolver: {
      resolve: async (instanceId) => {
        if (instanceId === TASK_INSTANCE.instanceId) return TASK_INSTANCE;
        if (instanceId === SETUP_INSTANCE.instanceId) return SETUP_INSTANCE;
        return undefined;
      },
    } as InstanceResolver,
    githubToken: "ghp_test_token",
    postMessage: async (threadId, content) => {
      host.posts.push({ threadId, content });
    },
    editMessage: async (threadId, messageId, content) => {
      host.edits.push({ threadId, messageId, content });
    },
    environmentIssueStore: {
      insert: async (issue) => {
        host.issues.push({ ...issue });
      },
      listUnresolved: async () => [],
      resolve: async () => {},
    },
    setupStore: {
      appendReadyProfileMemory: async (input) => {
        host.setupMemoryAppends.push(input);
        return { ok: true, profile: { revision: 3 } as any };
      },
      promoteRun: async () => ({ id: "profile-1", revision: 1 } as any),
      failRun: async () => true,
      getRunByInstanceId: async (instanceId) =>
        instanceId === SETUP_INSTANCE.instanceId
          ? ({
              id: "run-1",
              profileId: "profile-1",
              repo: "acme/web",
              branch: "main",
              workspacePath: testWorkspacePath,
            } as any)
          : undefined,
      getProfileById: async (profileId) =>
        profileId === "profile-1"
          ? ({
              id: "profile-1",
              repo: "acme/web",
              branch: "main",
              revision: 2,
              status: "running",
              environment: {
                install: "npm install",
                start: "",
                checks: { unit: "npm run test:unit" },
                requiredEnv: [],
                requiredServices: [],
              },
              memoryMarkdown: "Existing memory.",
            } as any)
          : undefined,
      createDraft: async (profileId, discordUserId) => {
        const draft = {
          id: "draft-1",
          profileId,
          discordUserId,
          baseRevision: 2,
          environment: {},
          memoryMarkdown: "",
        };
        host.setupDrafts.push(draft);
        return draft as any;
      },
      updateDraft: async (input) => {
        const draft = host.setupDrafts.find((d) => d.id === input.draftId);
        if (draft) {
          draft.environment = input.environment ?? draft.environment;
          draft.memoryMarkdown = input.memoryMarkdown ?? draft.memoryMarkdown;
        }
        return draft as any;
      },
    },
    taskStore: {
      getByInstanceId: async () => undefined,
    },
    gitExecutor: {
      run: async (command, cwd, env) => {
        host.gitExecutorRuns.push({ command, cwd, env });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as GitExecutor,
    octokitFactory: (() => ({
      rest: { pulls: { create: async () => ({ data: { number: 42, html_url: "http://pr/42", state: "open" } }) } },
    })) as OctokitFactory,
    verifySetupEnvironment: async () => ({ ok: true }),
  };
}

let host: ReturnType<typeof createFakeBindingsHost>;

beforeEach(async () => {
  clearPendingUserTurnMessage(TASK_INSTANCE.instanceId);
  testWorkspacePath = await mkdtemp(join(tmpdir(), "threadcord-bindings-"));
  host = createFakeBindingsHost();
});

afterEach(async () => {
  if (testWorkspacePath && testWorkspacePath !== "/workspaces/task-1") {
    await rm(testWorkspacePath, { recursive: true, force: true });
  }
});

async function runTool<T>(
  tool: HostTool<T, ToolOutput>,
  input: unknown,
): Promise<ToolOutput> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return tool.execute(parsed.data as T);
}

describe("AgentOS bindings parity", () => {
  describe("post_thread_message", () => {
    it("queues a validated final user-facing message for the instance", async () => {
      const tool = createPostThreadMessageTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        message: VALID_MESSAGE,
      });

      expect(result).toEqual({ ok: true, value: "Message queued for Discord." });
      expect(takePendingUserTurnMessages(TASK_INSTANCE.instanceId)).toEqual([
        VALID_MESSAGE,
      ]);
    });

    it("rejects an empty message", async () => {
      const tool = createPostThreadMessageTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        message: "",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/message/);
      }
    });

    it("rejects an oversized message", async () => {
      const tool = createPostThreadMessageTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        message: "## Summary\n" + "x".repeat(1900),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/too_big|max|length|1900/i);
      }
    });

    it("rejects content with no ## headers", async () => {
      const tool = createPostThreadMessageTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        message: "Fixed the bug. Tests pass.",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("## section header");
      }
    });

    it("rejects thin content with a header but no substantive body", async () => {
      const tool = createPostThreadMessageTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        message: "## Summary\nDone.",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("substantive body");
      }
    });

    it("is mutually exclusive with post_thread_report", async () => {
      const postTool = createPostThreadMessageTool(host);
      const reportTool = createPostThreadReportTool(host);
      await runTool(postTool, {
        instanceId: TASK_INSTANCE.instanceId,
        message: VALID_MESSAGE,
      });

      const result = await runTool(reportTool, {
        instanceId: TASK_INSTANCE.instanceId,
        parts: ["## Summary\nA short but substantive body here."],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/already has a queued report/i);
      }
    });
  });

  describe("post_thread_report", () => {
    it("queues one part as a single pending entry", async () => {
      const tool = createPostThreadReportTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        parts: ["## Summary\nA short but substantive body here."],
      });

      expect(result).toEqual({
        ok: true,
        value: "1 report part(s) queued for Discord.",
      });
      expect(takePendingUserTurnMessages(TASK_INSTANCE.instanceId)).toEqual([
        "## Summary\nA short but substantive body here.",
      ]);
    });

    it("queues six parts in order", async () => {
      const tool = createPostThreadReportTool(host);
      const parts = Array.from(
        { length: 6 },
        (_, index) =>
          `## Section ${index + 1}\nThis section contains substantial body text explaining what was observed, changed, and verified during this part of the investigation.`,
      );
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        parts,
      });

      expect(result).toEqual({
        ok: true,
        value: "6 report part(s) queued for Discord.",
      });
      expect(takePendingUserTurnMessages(TASK_INSTANCE.instanceId)).toEqual(
        parts,
      );
    });

    it("rejects empty parts arrays", async () => {
      const tool = createPostThreadReportTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        parts: [],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/parts/);
      }
    });

    it("rejects more than six parts", async () => {
      const tool = createPostThreadReportTool(host);
      const parts = Array.from(
        { length: 7 },
        (_, index) => `## Section ${index + 1}\nBody ${index + 1} here.`,
      );
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        parts,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/6/);
      }
    });

    it("rejects parts longer than 1900 chars", async () => {
      const tool = createPostThreadReportTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        parts: ["## Summary\n" + "x".repeat(1901)],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/1900|too_big|max/i);
      }
    });

    it("rejects when only one part of many is thin", async () => {
      const tool = createPostThreadReportTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        parts: [VALID_MESSAGE, "## Summary\nDone."],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Part 2");
      }
    });

    it("is mutually exclusive with post_thread_message", async () => {
      const reportTool = createPostThreadReportTool(host);
      const postTool = createPostThreadMessageTool(host);
      await runTool(reportTool, {
        instanceId: TASK_INSTANCE.instanceId,
        parts: ["## Summary\nA short but substantive body here."],
      });

      const result = await runTool(postTool, {
        instanceId: TASK_INSTANCE.instanceId,
        message: VALID_MESSAGE,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/already has a queued report/i);
      }
    });
  });

  describe("edit_thread_message", () => {
    it("edits a message in the resolved thread", async () => {
      const tool = createEditThreadMessageTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        messageId: "msg-123",
        content: "Updated message content.",
      });

      expect(result).toEqual({ ok: true, value: "Message edited on Discord." });
      expect(host.edits).toEqual([
        {
          threadId: TASK_INSTANCE.threadId,
          messageId: "msg-123",
          content: "Updated message content.",
        },
      ]);
    });

    it("rejects an unknown instance", async () => {
      const tool = createEditThreadMessageTool(host);
      const result = await runTool(tool, {
        instanceId: "discord:thread:unknown",
        messageId: "msg-123",
        content: "Updated message content.",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Unknown instance");
      }
    });

    it("rejects empty content", async () => {
      const tool = createEditThreadMessageTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        messageId: "msg-123",
        content: "",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/content/);
      }
    });

    it("rejects content over 2000 chars", async () => {
      const tool = createEditThreadMessageTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        messageId: "msg-123",
        content: "x".repeat(2001),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/2000|too_big|max/i);
      }
    });
  });

  describe("create_github_pull_request", () => {
    it("creates a PR and returns { number, url, state }", async () => {
      const tool = createGitHubPullRequestTool(host);
      const result = await runTool(tool, {
        owner: "acme",
        repo: "web",
        title: "Fix login redirect loop",
        head: "threadcord/fix/login-redirect",
        base: "main",
        body: "Moved the token check after the session setter.",
      });

      expect(result).toEqual({
        ok: true,
        value: {
          number: 42,
          url: "http://pr/42",
          state: "open",
        },
      });
    });

    it("creates a PR without optional body", async () => {
      const tool = createGitHubPullRequestTool(host);
      const result = await runTool(tool, {
        owner: "acme",
        repo: "web",
        title: "Fix login redirect loop",
        head: "threadcord/fix/login-redirect",
        base: "main",
      });

      expect(result.ok).toBe(true);
    });

    it("returns a bounded error when Octokit fails", async () => {
      host.octokitFactory = () =>
        ({
          rest: {
            pulls: {
              create: async () => {
                throw new Error("Validation failed");
              },
            },
          },
        }) as any;
      const tool = createGitHubPullRequestTool(host);
      const result = await runTool(tool, {
        owner: "acme",
        repo: "web",
        title: "Fix login redirect loop",
        head: "threadcord/fix/login-redirect",
        base: "main",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Validation failed");
      }
    });
  });

  describe("git_push", () => {
    it("pushes a threadcord/* branch using the server-side PAT", async () => {
      const tool = createGitPushTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        branch: "threadcord/fix/login-redirect",
      });

      expect(result).toEqual({
        ok: true,
        value: "Pushed threadcord/fix/login-redirect to origin.",
      });
      expect(host.gitExecutorRuns).toHaveLength(1);
      const run = host.gitExecutorRuns[0]!;
      expect(run.command).toEqual(["push", "origin", "threadcord/fix/login-redirect"]);
      expect(run.cwd).toBe(TASK_INSTANCE.workspacePath);
      expect(run.env.GITHUB_TOKEN).toBe(host.githubToken);
      expect(run.env.GH_TOKEN).toBe(host.githubToken);
      expect(run.env.GIT_ASKPASS).toBeDefined();
    });

    it("pushes the base branch", async () => {
      const tool = createGitPushTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        branch: TASK_INSTANCE.branch,
      });

      expect(result.ok).toBe(true);
    });

    it("rejects disallowed branches", async () => {
      const tool = createGitPushTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        branch: "feature/sneaky",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("feature/sneaky");
        expect(result.error).toContain("threadcord/*");
      }
    });

    it("rejects force-push", async () => {
      const tool = createGitPushTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        branch: "threadcord/fix/login-redirect",
        force: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Force-push");
      }
    });

    it("returns a bounded error when git fails", async () => {
      host.gitExecutor = {
        run: async () => ({ exitCode: 1, stdout: "", stderr: "rejected" }),
      } as GitExecutor;
      const tool = createGitPushTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        branch: "threadcord/fix/login-redirect",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("rejected");
      }
    });
  });

  describe("append_threadcord_setup_memory", () => {
    it("appends validated Markdown to the setup profile for the instance repo/branch", async () => {
      const tool = createAppendSetupMemoryTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        markdown: "Use `npm run test:unit` for focused checks; integration tests need Postgres.",
      });

      expect(result).toEqual({
        ok: true,
        value: { status: "appended", revision: 3 },
      });
      expect(host.setupMemoryAppends).toEqual([
        {
          repo: TASK_INSTANCE.repo,
          branch: TASK_INSTANCE.branch,
          appendMarkdown: "Use `npm run test:unit` for focused checks; integration tests need Postgres.",
        },
      ]);
    });

    it("rejects empty Markdown", async () => {
      const tool = createAppendSetupMemoryTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        markdown: "",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/markdown/);
      }
    });

    it("rejects Markdown that appears to contain a secret", async () => {
      const tool = createAppendSetupMemoryTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        markdown: "token: REDACTED_TEST_VALUE",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("secret");
      }
    });

    it("returns a bounded error when the store rejects the append", async () => {
      host.setupStore = {
        ...host.setupStore,
        appendReadyProfileMemory: async () => ({
          ok: false,
          reason: "not_ready",
          message: "Profile is not ready.",
        }),
      };
      const tool = createAppendSetupMemoryTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        markdown: "A valid memory note.",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not ready");
      }
    });
  });

  describe("report_environment_issue", () => {
    it("creates an issue row and posts a Discord milestone", async () => {
      const tool = createReportEnvironmentIssueTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        kind: "missing_package",
        message: "The jq binary is missing from the execution environment.",
        suggestedAction: "Install jq via the host package manager.",
      });

      expect(result.ok).toBe(true);
      expect(host.issues).toHaveLength(1);
      const issue = host.issues[0]!;
      expect(issue.kind).toBe("missing_package");
      expect(issue.taskId).toBe(TASK_INSTANCE.taskId);
      expect(issue.message).toContain("jq binary is missing");
      expect(host.posts).toHaveLength(1);
      expect(host.posts[0]!.threadId).toBe(TASK_INSTANCE.threadId);
      expect(host.posts[0]!.content).toContain("missing_package");
    });

    it("rejects an unknown kind", async () => {
      const tool = createReportEnvironmentIssueTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        kind: "not_a_kind",
        message: "Something is wrong.",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/kind/);
      }
    });
  });

  describe("request_missing_secret", () => {
    it("creates a missing_env issue and posts a milestone", async () => {
      const tool = createRequestMissingSecretTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        name: "ANTHROPIC_API_KEY",
        reason: "The model provider requires this key.",
      });

      expect(result.ok).toBe(true);
      expect(host.issues).toHaveLength(1);
      const issue = host.issues[0]!;
      expect(issue.kind).toBe("missing_env");
      expect(issue.requiredEnv).toEqual(["ANTHROPIC_API_KEY"]);
      expect(host.posts[0]!.content).toContain("ANTHROPIC_API_KEY");
    });
  });

  describe("request_network_access", () => {
    it("creates a blocked_network issue and posts a milestone", async () => {
      const tool = createRequestNetworkAccessTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        host: "api.example.com",
        port: 443,
        reason: "The agent needs to reach this API.",
      });

      expect(result.ok).toBe(true);
      expect(host.issues).toHaveLength(1);
      const issue = host.issues[0]!;
      expect(issue.kind).toBe("blocked_network");
      expect(issue.blockedHost).toBe("api.example.com");
      expect(issue.blockedPort).toBe(443);
      expect(host.posts[0]!.content).toContain("api.example.com:443");
    });
  });

  describe("record_setup_memory", () => {
    it("records setup memory with optional evidence", async () => {
      const tool = createRecordSetupMemoryTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        markdown: "Use `npm run test:unit` for focused checks.",
        evidence: "CI passes on the last commit.",
      });

      expect(result).toEqual({
        ok: true,
        value: { status: "recorded", revision: 3 },
      });
      expect(host.setupMemoryAppends).toHaveLength(1);
      expect(host.setupMemoryAppends[0]!.appendMarkdown).toContain("Evidence");
    });

    it("rejects secret-looking evidence", async () => {
      const tool = createRecordSetupMemoryTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        markdown: "A valid memory note.",
        evidence: "token: REDACTED_TEST_VALUE",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("secret");
      }
    });
  });

  describe("propose_setup_profile_change", () => {
    it("creates a setup draft from the current profile with a patch and milestone", async () => {
      const tool = createProposeSetupProfileChangeTool(host);
      const result = await runTool(tool, {
        instanceId: SETUP_INSTANCE.instanceId,
        environmentPatch: {
          requiredEnv: ["ANTHROPIC_API_KEY"],
        },
        memoryMarkdown: "Updated memory.",
        reason: "Add required model key.",
      });

      expect(result.ok).toBe(true);
      expect(host.setupDrafts).toHaveLength(1);
      const draft = host.setupDrafts[0]!;
      expect(draft.environment.requiredEnv).toEqual(["ANTHROPIC_API_KEY"]);
      expect(draft.memoryMarkdown).toBe("Updated memory.");
      expect(host.posts).toHaveLength(1);
      expect(host.posts[0]!.threadId).toBe(SETUP_INSTANCE.threadId);
      expect(host.posts[0]!.content).toContain("draft");
    });

    it("rejects invalid environment patches", async () => {
      const tool = createProposeSetupProfileChangeTool(host);
      const result = await runTool(tool, {
        instanceId: SETUP_INSTANCE.instanceId,
        environmentPatch: {
          requiredEnv: ["lowercase"],
        },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("required environment variable name");
      }
    });

    it("rejects non-setup instances", async () => {
      const tool = createProposeSetupProfileChangeTool(host);
      const result = await runTool(tool, {
        instanceId: TASK_INSTANCE.instanceId,
        memoryMarkdown: "Updated memory.",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Unknown setup instance");
      }
    });
  });

  describe("save_threadcord_setup_profile", () => {
    it("verifies and promotes the setup run", async () => {
      host.verifySetupEnvironment = async () => ({ ok: true });
      const tool = createSaveThreadcordSetupProfileTool(host);
      const result = await runTool(tool, {
        instanceId: SETUP_INSTANCE.instanceId,
        environment: {
          install: "npm install",
          checks: { unit: "npm run test:unit" },
        },
        memoryMarkdown: "Saved memory.",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({
          status: "saved",
          revision: 1,
        });
      }
    });

    it("returns a bounded error when verification fails", async () => {
      host.verifySetupEnvironment = async () => ({
        ok: false,
        failures: [
          {
            name: "unit",
            command: "npm run test:unit",
            output: "tests failed",
          },
        ],
      });
      const tool = createSaveThreadcordSetupProfileTool(host);
      const result = await runTool(tool, {
        instanceId: SETUP_INSTANCE.instanceId,
        environment: {
          install: "npm install",
          checks: { unit: "npm run test:unit" },
        },
        memoryMarkdown: "Saved memory.",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("tests failed");
      }
    });
  });
});
