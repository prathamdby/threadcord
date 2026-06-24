import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureWorkspaceDirs,
  workspaceEnv,
  workspacePaths,
} from "../src/task/workspace-env.js";

describe("workspacePaths", () => {
  it("returns scoped home, npm prefix, bin, and cache paths", () => {
    const paths = workspacePaths("/tmp/ws");
    expect(paths.home).toBe("/tmp/ws/.home");
    expect(paths.npmPrefix).toBe("/tmp/ws/.npm-global");
    expect(paths.npmBin).toBe("/tmp/ws/.npm-global/bin");
    expect(paths.cache).toBe("/tmp/ws/.cache");
  });
});

describe("workspaceEnv", () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = "/usr/bin";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("scopes HOME, npm prefix, cache, and PATH", () => {
    const env = workspaceEnv("/tmp/ws", {
      GITHUB_TOKEN: "token",
      GH_TOKEN: "token",
    });

    expect(env.HOME).toBe("/tmp/ws/.home");
    expect(env.NPM_CONFIG_PREFIX).toBe("/tmp/ws/.npm-global");
    expect(env.XDG_CACHE_HOME).toBe("/tmp/ws/.cache");
    expect(env.PATH).toBe("/tmp/ws/.npm-global/bin:/usr/bin");
    expect(env.GITHUB_TOKEN).toBe("token");
    expect(env.GH_TOKEN).toBe("token");
  });

  it("lets extra override built-in values", () => {
    const env = workspaceEnv("/tmp/ws", { HOME: "/override" });
    expect(env.HOME).toBe("/override");
  });

  it("does not mutate process.env", () => {
    const before = { ...process.env };
    workspaceEnv("/tmp/ws");
    expect(process.env).toEqual(before);
  });

  it("handles undefined PATH without a trailing colon", () => {
    delete process.env.PATH;
    const env = workspaceEnv("/tmp/ws");
    expect(env.PATH).toBe("/tmp/ws/.npm-global/bin");
    expect(env.PATH?.endsWith(":")).toBe(false);
  });
});

describe("ensureWorkspaceDirs", () => {
  let tempRoot = "";

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("creates scoped workspace directories", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "threadcord-ws-"));
    await ensureWorkspaceDirs(tempRoot);

    await expect(stat(join(tempRoot, ".home"))).resolves.toBeDefined();
    await expect(stat(join(tempRoot, ".npm-global"))).resolves.toBeDefined();
    await expect(stat(join(tempRoot, ".cache"))).resolves.toBeDefined();
  });
});
