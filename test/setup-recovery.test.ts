import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { SetupOrchestrator } from "../src/setup/orchestrator.js";
import type { SetupRun } from "../src/setup/profile.js";
import type { SetupStore } from "../src/setup/store.js";

function makeRun(
  overrides: Partial<SetupRun> & Pick<SetupRun, "id" | "workspacePath">,
): SetupRun {
  return {
    profileId: "profile-1",
    repo: "owner/repo",
    branch: "main",
    model: "anthropic/claude-sonnet-4-5",
    status: "running",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("setup restart recovery", () => {
  const workspaceRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (workspaceRoots.length > 0) {
      const root = workspaceRoots.pop();
      if (root) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  async function createWorkspace(label: string): Promise<string> {
    const root = await mkdtemp(
      join(tmpdir(), `threadcord-setup-recovery-${label}-`),
    );
    workspaceRoots.push(root);
    return root;
  }

  function createOrchestrator(store: SetupStore): SetupOrchestrator {
    return new SetupOrchestrator({} as AppConfig, store);
  }

  it("fails every interrupted run and removes its workspace", async () => {
    const workspaceA = await createWorkspace("a");
    const workspaceB = await createWorkspace("b");
    const runA = makeRun({ id: "run-a", workspacePath: workspaceA });
    const runB = makeRun({ id: "run-b", workspacePath: workspaceB });
    const failRun = vi.fn().mockResolvedValue(true);
    const store = {
      listRunningRuns: vi.fn().mockResolvedValue([runA, runB]),
      failRun,
    } as unknown as SetupStore;

    await createOrchestrator(store).resumeAfterRestart();

    expect(failRun).toHaveBeenCalledTimes(2);
    expect(failRun).toHaveBeenNthCalledWith(
      1,
      "run-a",
      "Setup interrupted by process restart.",
    );
    expect(failRun).toHaveBeenNthCalledWith(
      2,
      "run-b",
      "Setup interrupted by process restart.",
    );
    await expect(stat(workspaceA)).rejects.toThrow();
    await expect(stat(workspaceB)).rejects.toThrow();
  });

  it("logs a failed reconciliation and continues with the next run", async () => {
    const workspaceGood = await createWorkspace("good");
    const runBad = makeRun({
      id: "run-bad",
      workspacePath: "/tmp/missing-setup-workspace-bad",
    });
    const runGood = makeRun({ id: "run-good", workspacePath: workspaceGood });
    const failRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockResolvedValueOnce(true);
    const store = {
      listRunningRuns: vi.fn().mockResolvedValue([runBad, runGood]),
      failRun,
    } as unknown as SetupStore;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await createOrchestrator(store).resumeAfterRestart();

      expect(failRun).toHaveBeenCalledTimes(2);
      expect(failRun).toHaveBeenNthCalledWith(
        1,
        "run-bad",
        "Setup interrupted by process restart.",
      );
      expect(failRun).toHaveBeenNthCalledWith(
        2,
        "run-good",
        "Setup interrupted by process restart.",
      );
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls
        .map((call) => call.map(String).join(" "))
        .join("\n");
      expect(logged).toContain("run-bad");
      expect(logged).toContain("restart recovery failed");
      await expect(stat(workspaceGood)).rejects.toThrow();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not remove a workspace when failRun returns false", async () => {
    const workspace = await createWorkspace("kept");
    const run = makeRun({ id: "run-stale", workspacePath: workspace });
    const failRun = vi.fn().mockResolvedValue(false);
    const store = {
      listRunningRuns: vi.fn().mockResolvedValue([run]),
      failRun,
    } as unknown as SetupStore;

    await createOrchestrator(store).resumeAfterRestart();

    expect(failRun).toHaveBeenCalledWith(
      "run-stale",
      "Setup interrupted by process restart.",
    );
    await expect(stat(workspace)).resolves.toBeDefined();
  });
});
