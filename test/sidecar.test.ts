import { describe, expect, it } from "vitest";
import {
  getSidecarInfo,
  probeSidecar,
  resolveSidecarPath,
} from "../src/agentturn/sidecar.js";

describe("sidecar readiness", () => {
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
    expect(result.arch).toBe("arm64");
    expect(result.version).toMatch(/aarch64|arm64/i);
  });
});
