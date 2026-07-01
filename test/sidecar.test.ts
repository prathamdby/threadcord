import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSidecarInfo,
  probeSidecar,
  resolveSidecarPath,
} from "../src/agentturn/sidecar.js";

describe("sidecar readiness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("resolves the sidecar binary path", () => {
    const path = resolveSidecarPath();
    expect(path.length).toBeGreaterThan(0);
    expect(path).toContain("agentos-sidecar");
  });

  it("reports the sidecar as executable on supported platforms", async () => {
    const info = await getSidecarInfo();
    expect(info.path).toContain("agentos-sidecar");
    expect(info.executable).toBe(true);
    expect(["arm64", "x64"]).toContain(info.arch);
  });

  it("probes the sidecar successfully on supported platforms", async () => {
    const result = await probeSidecar();
    expect(result.ok).toBe(true);
    expect(result.path).toContain("agentos-sidecar");
    expect(result.executable).toBe(true);
    expect(["arm64", "x64"]).toContain(result.arch);
    if (result.arch === "arm64") {
      expect(result.version).toMatch(/aarch64|arm64/i);
    } else {
      expect(result.version).toMatch(/x86-?64|x86_64/i);
    }
  });

  it("rejects unsupported host architectures", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "arch", "get").mockReturnValue("ia32");

    const result = await probeSidecar();

    expect(result.ok).toBe(false);
    expect(result.executable).toBe(false);
    expect(result.error).toMatch(/unsupported host architecture/i);
  });

  it("rejects a non-executable sidecar binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "threadcord-sidecar-"));
    const nonExecutable = join(dir, "sidecar");
    await writeFile(nonExecutable, "not a real sidecar", { mode: 0o644 });
    vi.stubEnv("AGENTOS_SIDECAR_BIN", nonExecutable);

    const result = await probeSidecar();

    expect(result.ok).toBe(false);
    expect(result.executable).toBe(false);
    expect(result.path).toBe(nonExecutable);
  });
});
