import { describe, expect, it } from "vitest";
import {
  exportProfile,
  renderSetupProfile,
  renderSetupStatus,
} from "../src/setup/renderer.js";
import type { SetupProfile, SetupRun } from "../src/setup/profile.js";

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

  it("renders status separately from full profile view", () => {
    const running: SetupProfile = { ...profile, status: "running" };
    const run: SetupRun = {
      id: "run-1",
      profileId: "profile-1",
      repo: "owner/repo",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      workspacePath: "/workspaces/setup",
      status: "running",
      discordThreadId: "thread-setup",
      progressMessageIds: ["msg-1"],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const status = renderSetupStatus({ profile: running, run });
    expect(status.content).toContain("Status: running");
    expect(status.content).toContain("Run status: running");
    expect(status.content).toContain("<#thread-setup>");
    expect(status.content).not.toContain("Install: npm ci");
    expect(status.content).toContain("/setup view");
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