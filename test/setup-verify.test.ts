import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SetupEnvironment } from "../src/setup/profile.js";
import {
  formatSetupVerifyError,
  verifySetupEnvironment,
} from "../src/setup/verify.js";
import { ensureWorkspaceDirs, workspacePaths } from "../src/task/workspace-env.js";

describe("verifySetupEnvironment", () => {
  let workspaceRoot = "";

  afterEach(async () => {
    if (workspaceRoot) {
      await rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = "";
    }
  });

  async function createWorkspace(): Promise<{
    workspaceRoot: string;
    checkoutDir: string;
  }> {
    workspaceRoot = await mkdtemp(join(tmpdir(), "threadcord-setup-verify-"));
    const checkoutDir = join(workspaceRoot, "repo");
    await mkdir(checkoutDir, { recursive: true });
    await ensureWorkspaceDirs(workspaceRoot);
    return { workspaceRoot, checkoutDir };
  }

  function baseEnvironment(
    overrides: Partial<SetupEnvironment> = {},
  ): SetupEnvironment {
    return {
      install: "true",
      start: "",
      checks: {},
      requiredEnv: [],
      requiredServices: [],
      ...overrides,
    };
  }

  async function verify(
    environment: SetupEnvironment,
    options: {
      installTimeoutMs?: number;
      checkTimeoutMs?: number;
      startProbeMs?: number;
    } = {},
  ) {
    const { workspaceRoot: root, checkoutDir } = await createWorkspace();
    return verifySetupEnvironment({
      environment,
      workspaceRoot: root,
      checkoutDir,
      githubToken: "github-token",
      ...options,
    });
  }

  it("passes with a successful install and zero checks", async () => {
    const result = await verify(baseEnvironment());
    expect(result).toEqual({ ok: true });
  });

  it("passes with a successful install and one passing check", async () => {
    const result = await verify(
      baseEnvironment({ checks: { build: "true" } }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("fails on install and skips checks", async () => {
    const { workspaceRoot: root, checkoutDir } = await createWorkspace();
    const marker = join(checkoutDir, "check-ran.txt");
    const result = await verifySetupEnvironment({
      environment: baseEnvironment({
        install: "exit 1",
        checks: { build: `touch ${marker}` },
      }),
      workspaceRoot: root,
      checkoutDir,
      githubToken: "",
      checkTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.name).toBe("install");
    }
    await expect(stat(marker)).rejects.toThrow();
  });

  it("fails when a check exits non-zero", async () => {
    const result = await verify(
      baseEnvironment({ checks: { build: "exit 1" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures[0]?.name).toBe("check:build");
    }
  });

  it("runs checks in sorted name order", async () => {
    const { workspaceRoot: root, checkoutDir } = await createWorkspace();
    const orderFile = join(checkoutDir, "order.txt");
    const result = await verifySetupEnvironment({
      environment: baseEnvironment({
        checks: {
          b: `echo b >> ${orderFile}`,
          a: `echo a >> ${orderFile}`,
        },
      }),
      workspaceRoot: root,
      checkoutDir,
      githubToken: "",
    });
    expect(result).toEqual({ ok: true });
    const order = await readFile(orderFile, "utf8");
    expect(order).toBe("a\nb\n");
  });

  it("skips an empty start command", async () => {
    const result = await verify(baseEnvironment({ start: "   " }));
    expect(result).toEqual({ ok: true });
  });

  it("passes when start exits zero immediately", async () => {
    const result = await verify(
      baseEnvironment({ start: "true" }),
      { startProbeMs: 50 },
    );
    expect(result).toEqual({ ok: true });
  });

  it("fails when start exits non-zero immediately", async () => {
    const result = await verify(
      baseEnvironment({ start: "exit 2" }),
      { startProbeMs: 50 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures[0]?.name).toBe("start");
    }
  });

  it("passes when start stays alive through the probe window", async () => {
    const result = await verify(
      baseEnvironment({ start: "sleep 1" }),
      { startProbeMs: 50 },
    );
    expect(result).toEqual({ ok: true });
  });

  it("redacts token-shaped output in failures", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const result = await verify(
      baseEnvironment({ install: `echo ${token} >&2; exit 1` }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures[0]?.output).not.toContain(token);
      expect(result.failures[0]?.output).toContain("[redacted]");
    }
  });

  it("truncates failure output to the tail", async () => {
    const marker = "TAIL-MARKER-END";
    const result = await verify(
      baseEnvironment({
        install: `printf '%*s' 3000 '' | tr ' ' x; echo ${marker} >&2; exit 1`,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures[0]?.output.length).toBeLessThanOrEqual(2000);
      expect(result.failures[0]?.output).toContain(marker);
      expect(result.failures[0]?.output).not.toMatch(/^x{100}/);
    }
  });

  it("keeps workspace npm bin first on PATH", async () => {
    const { workspaceRoot: root, checkoutDir } = await createWorkspace();
    const pathFile = join(checkoutDir, "path.txt");
    const result = await verifySetupEnvironment({
      environment: baseEnvironment({
        install: `printf '%s' "$PATH" > ${pathFile}`,
      }),
      workspaceRoot: root,
      checkoutDir,
      githubToken: "",
    });
    expect(result).toEqual({ ok: true });
    const capturedPath = await readFile(pathFile, "utf8");
    expect(capturedPath.split(":")[0]).toBe(workspacePaths(root).npmBin);
  });

  it("caps combined verify error output", async () => {
    const message = formatSetupVerifyError({
      ok: false,
      failures: [
        {
          name: "install",
          command: "npm ci",
          output: "x".repeat(4000),
        },
      ],
    });
    expect(message.length).toBeLessThanOrEqual(3500);
    expect(message.startsWith("Setup verification failed.")).toBe(true);
  });
});
