import { describe, expect, it } from "vitest";
import { exportProfile, renderSetupProfile } from "../src/setup/renderer.js";
import type { SetupProfile } from "../src/setup/profile.js";

const profile: SetupProfile = {
  id: "profile-1",
  repo: "owner/repo",
  branch: "main",
  status: "ready",
  revision: 3,
  environment: {
    install: "npm ci",
    start: "npm run dev",
    checks: { build: "npm run build", test: "npm test" },
    requiredEnv: ["DATABASE_URL"],
    requiredServices: ["postgres"],
  },
  memoryMarkdown: "Use npm. Tests need Postgres.",
  lastRunId: "run-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("setup renderer", () => {
  it("renders profile state for Discord", () => {
    expect(renderSetupProfile(profile).content).toContain(
      "Setup profile for owner/repo on main",
    );
    expect(renderSetupProfile(profile).content).toContain("Install: npm ci");
    expect(renderSetupProfile(profile).content).toContain(
      "Required env: DATABASE_URL",
    );
  });

  it("exports environment JSON and memory Markdown", () => {
    const view = exportProfile(profile);

    expect(view.files?.map((file) => file.name)).toEqual([
      "owner-repo-main-environment.json",
      "owner-repo-main-memory.md",
    ]);
    expect(view.files?.[0]?.content).toContain('"install": "npm ci"');
    expect(view.files?.[1]?.content).toBe("Use npm. Tests need Postgres.");
  });
});
