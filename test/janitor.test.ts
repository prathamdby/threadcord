import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupExpiredWorkspaces,
  type WorkspaceJanitorStore,
} from "../src/task/janitor.js";

class FakeJanitorStore implements WorkspaceJanitorStore {
  constructor(private readonly paths: string[]) {}

  listExpiredWorkspacePaths(_ttlDays: number): Promise<string[]> {
    return Promise.resolve(this.paths);
  }
}

describe("cleanupExpiredWorkspaces", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "threadcord-janitor-"));
    cleanups.push(root);
    return root;
  }

  it("deletes a valid expired workspace under the root", async () => {
    const root = await makeRoot();
    const taskId = "550e8400-e29b-41d4-a716-446655440000";
    const workspace = join(root, taskId);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "artifact.txt"), "data");

    await cleanupExpiredWorkspaces(
      new FakeJanitorStore([workspace]),
      root,
      14,
    );

    await expect(writeFile(join(workspace, "probe"), "x")).rejects.toThrow();
  });

  it("skips the workspace root itself", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "keep.txt"), "stay");

    const warnings: string[] = [];
    await cleanupExpiredWorkspaces(
      new FakeJanitorStore([root]),
      root,
      14,
      { warn: (message) => warnings.push(message) },
    );

    expect(await writeFile(join(root, "keep.txt"), "stay")).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/workspace root cannot be deleted/);
  });

  it("skips a path outside the workspace root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const victim = join(outside, "550e8400-e29b-41d4-a716-446655440001");
    await mkdir(victim, { recursive: true });

    const warnings: string[] = [];
    await cleanupExpiredWorkspaces(
      new FakeJanitorStore([victim]),
      root,
      14,
      { warn: (message) => warnings.push(message) },
    );

    expect(await writeFile(join(victim, "still-here"), "x")).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/outside workspace root/);
  });

  it("skips traversal-like candidates after normalization", async () => {
    const root = await makeRoot();
    const taskId = "550e8400-e29b-41d4-a716-446655440002";
    const escaped = join(root, "..", taskId);
    await mkdir(escaped, { recursive: true });
    const workspace = join(root, taskId);
    await mkdir(workspace, { recursive: true });

    const warnings: string[] = [];
    await cleanupExpiredWorkspaces(
      new FakeJanitorStore([join(root, taskId, "..", "..", taskId)]),
      root,
      14,
      { warn: (message) => warnings.push(message) },
    );

    expect(await writeFile(join(escaped, "still-here"), "x")).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/outside workspace root/);
    expect(await writeFile(join(workspace, "still-here"), "x")).toBeUndefined();
  });

  it("does not fail when a valid workspace path is already missing", async () => {
    const root = await makeRoot();
    const missing = join(root, "550e8400-e29b-41d4-a716-446655440003");

    await expect(
      cleanupExpiredWorkspaces(
        new FakeJanitorStore([missing]),
        root,
        14,
      ),
    ).resolves.toBeUndefined();
  });

  it("deletes valid workspaces even when another candidate is invalid", async () => {
    const root = await makeRoot();
    const validId = "550e8400-e29b-41d4-a716-446655440004";
    const valid = join(root, validId);
    await mkdir(valid, { recursive: true });
    const outside = await makeRoot();
    const invalid = join(outside, "550e8400-e29b-41d4-a716-446655440005");
    await mkdir(invalid, { recursive: true });

    await cleanupExpiredWorkspaces(
      new FakeJanitorStore([invalid, valid]),
      root,
      14,
    );

    await expect(writeFile(join(valid, "probe"), "x")).rejects.toThrow();
    expect(await writeFile(join(invalid, "still-here"), "x")).toBeUndefined();
  });

  it("is idempotent when the workspace is already gone", async () => {
    const root = await makeRoot();
    const gone = join(root, "550e8400-e29b-41d4-a716-446655440006");

    await expect(
      cleanupExpiredWorkspaces(
        new FakeJanitorStore([gone]),
        root,
        14,
      ),
    ).resolves.toBeUndefined();
    await expect(
      cleanupExpiredWorkspaces(
        new FakeJanitorStore([gone]),
        root,
        14,
      ),
    ).resolves.toBeUndefined();
  });

  it("redacts secrets in skip warnings", async () => {
    const root = await makeRoot();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456";
    const warnings: string[] = [];

    await cleanupExpiredWorkspaces(
      new FakeJanitorStore([`/outside/${secret}`]),
      root,
      14,
      { warn: (message) => warnings.push(message) },
    );

    const joined = warnings.join("\n");
    expect(joined).not.toContain(secret);
    expect(joined).toContain("[redacted]");
  });

  it("skips symlinked paths that resolve outside the workspace root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const outsideTask = join(outside, "550e8400-e29b-41d4-a716-446655440007");
    await mkdir(outsideTask, { recursive: true });
    const linkName = "550e8400-e29b-41d4-a716-446655440008";
    const linkPath = join(root, linkName);
    await symlink(outsideTask, linkPath);

    const warnings: string[] = [];
    await cleanupExpiredWorkspaces(
      new FakeJanitorStore([linkPath]),
      root,
      14,
      { warn: (message) => warnings.push(message) },
    );

    expect(
      await writeFile(join(outsideTask, "still-here"), "x"),
    ).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/outside workspace root/);
  });
});