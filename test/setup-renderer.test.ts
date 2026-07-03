import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  exportProfile,
  renderSetupProfile,
  renderSetupStatus,
} from "../src/setup/renderer.js";
import { renderDraftView } from "../src/setup/draft-ui.js";
import type { SetupProfile, SetupRun } from "../src/setup/profile.js";

const IS_COMPONENTS_V2 = 32768;

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

function expectComponentsV2View(payload: { components: unknown[]; flags: number }) {
  expect(payload).not.toHaveProperty("content");
  expect(payload.flags & MessageFlags.IsComponentsV2).toBe(IS_COMPONENTS_V2);
}

describe("setup renderer", () => {
  it("renders profile state as Components v2", () => {
    const view = renderSetupProfile(profile);
    expectComponentsV2View(view);
    expect(JSON.stringify(view)).toContain("owner/repo");
    expect(JSON.stringify(view)).toContain("npm ci");
    expect(JSON.stringify(view)).toContain("DATABASE_URL");
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
    expectComponentsV2View(status);
    expect(JSON.stringify(status)).toContain("running");
    expect(JSON.stringify(status)).toContain("thread-setup");
    expect(JSON.stringify(status)).not.toContain("npm ci");
    expect(JSON.stringify(status)).toContain("Setup status");
  });

  it("renders draft editor view with action buttons", () => {
    const draft = {
      id: "draft-1",
      profileId: profile.id,
      discordUserId: "user-1",
      baseRevision: 3,
      environment: profile.environment,
      memoryMarkdown: profile.memoryMarkdown,
      validationStatus: "unchecked" as const,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
    const view = renderDraftView(draft);
    expectComponentsV2View(view);
    expect(JSON.stringify(view)).toContain("setup:validate:draft-1");
    expect(JSON.stringify(view)).toContain("setup:discard:draft-1");
  });

  it("exports environment JSON and memory Markdown with cv2 summary", () => {
    const bundle = exportProfile(profile);
    expectComponentsV2View(bundle.view);
    expect(bundle.files.map((file) => file.name)).toEqual([
      "owner-repo-main-environment.json",
      "owner-repo-main-memory.md",
    ]);
    expect(bundle.files[0]?.content).toContain('"install": "npm ci"');
    expect(bundle.files[1]?.content).toBe("Use npm. Tests need Postgres.");
    expect(JSON.stringify(bundle.view)).toContain("owner/repo");
  });
});
