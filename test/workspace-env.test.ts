import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverHomeBinDirs,
  ensureWorkspaceDirs,
  workspaceEnv,
  workspacePathPrefix,
  workspacePaths,
  wrapWorkspaceBashCommand,
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

describe("discoverHomeBinDirs", () => {
  let tempRoot = "";

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("includes standard user-local bins even when HOME is missing", () => {
    expect(discoverHomeBinDirs("/tmp/missing-home")).toEqual([
      "/tmp/missing-home/bin",
      "/tmp/missing-home/.local/bin",
    ]);
  });

  it("includes every direct child bin directory under HOME", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "threadcord-home-bins-"));
    const home = join(tempRoot, ".home");
    await mkdir(join(home, ".cargo", "bin"), { recursive: true });
    await mkdir(join(home, ".nub", "bin"), { recursive: true });
    await mkdir(join(home, "tools", "bin"), { recursive: true });

    expect(discoverHomeBinDirs(home)).toEqual([
      join(home, "bin"),
      join(home, ".local", "bin"),
      join(home, ".cargo", "bin"),
      join(home, ".nub", "bin"),
      join(home, "tools", "bin"),
    ]);
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
    expect(env.PATH).toBe(workspacePathPrefix("/tmp/ws") + ":/usr/bin");
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
    expect(env.PATH).toBe(workspacePathPrefix("/tmp/ws"));
    expect(env.PATH?.endsWith(":")).toBe(false);
  });
});

describe("wrapWorkspaceBashCommand", () => {
  let tempRoot = "";

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("picks up a newly created child bin directory before the next command", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "threadcord-wrap-"));
    await ensureWorkspaceDirs(tempRoot);
    const home = workspacePaths(tempRoot).home;
    const marker = join(tempRoot, "marker.txt");
    const command = wrapWorkspaceBashCommand(
      [
        'mkdir -p "$HOME/.tool/bin"',
        'printf \'#!/bin/sh\\nprintf ok > "$1"\\n\' > "$HOME/.tool/bin/run"',
        'chmod +x "$HOME/.tool/bin/run"',
        `run "${marker}"`,
      ].join("\n"),
    );

    const { execa } = await import("../src/task/execa.js");
    await execa("bash", ["-c", command], {
      cwd: tempRoot,
      env: workspaceEnv(tempRoot),
    });

    await expect(stat(marker)).resolves.toBeDefined();
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
