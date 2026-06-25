import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  githubHttpsCloneUrl,
  githubHttpsGitEnv,
  prepareWorkspaceGitAuth,
  resolveGithubHttpsGitEnv,
  writeGitAskPass,
  workspaceGitAskPassPath,
} from "../src/task/git-auth.js";
import { workspacePaths } from "../src/task/workspace-env.js";

describe("git-auth", () => {
  let workspaceRoot = "";

  afterEach(async () => {
    if (workspaceRoot) {
      await rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = "";
    }
  });

  it("builds a standard github https clone url", () => {
    expect(githubHttpsCloneUrl("owner/repo")).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  it("writes an askpass script that uses x-access-token and GITHUB_TOKEN", async () => {
    const dir = await mkdtemp(join(tmpdir(), "threadcord-askpass-"));
    const askPassPath = join(dir, "askpass.sh");
    await writeGitAskPass(askPassPath);
    const script = await readFile(askPassPath, "utf8");
    expect(script).toContain("x-access-token");
    expect(script).toContain("$GITHUB_TOKEN");
  });

  it("persists askpass under the workspace and includes GIT_ASKPASS in env", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "threadcord-git-auth-"));
    const askPassPath = await prepareWorkspaceGitAuth(workspaceRoot);
    expect(askPassPath).toBe(workspaceGitAskPassPath(workspaceRoot));
    const env = await resolveGithubHttpsGitEnv(workspaceRoot, "secret");
    expect(env.GIT_ASKPASS).toBe(askPassPath);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GITHUB_TOKEN).toBe("secret");
    expect(env.HOME).toBe(workspacePaths(workspaceRoot).home);
  });

  it("merges extra env into github https git env", () => {
    const env = githubHttpsGitEnv("/tmp/ws", "t", "/tmp/askpass.sh", {
      GIT_AUTHOR_NAME: "bot",
    });
    expect(env.GIT_AUTHOR_NAME).toBe("bot");
    expect(env.GIT_ASKPASS).toBe("/tmp/askpass.sh");
  });
});