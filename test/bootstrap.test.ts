import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetupInstall } from "../src/task/bootstrap.js";
import { workspacePaths } from "../src/task/workspace-env.js";

describe("runSetupInstall", () => {
  let workspaceRoot = "";

  afterEach(async () => {
    if (workspaceRoot) {
      await rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = "";
    }
  });

  it("preserves the workspace npm bin first on PATH inside setup install", async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "threadcord-bootstrap-"));
    const checkoutDir = join(workspaceRoot, "repo");
    await mkdir(checkoutDir, { recursive: true });

    await runSetupInstall(
      workspaceRoot,
      checkoutDir,
      "printf '%s' \"$PATH\" > path.txt",
      "token",
    );

    const capturedPath = await readFile(join(checkoutDir, "path.txt"), "utf8");
    expect(capturedPath.split(delimiter)[0]).toBe(
      workspacePaths(workspaceRoot).npmBin,
    );
  });
});
