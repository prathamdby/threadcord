import { describe, expect, it } from "vitest";
import {
  parseSetupWizardCustomId,
  pendingFromRunModal,
  setupCreateRunModal,
} from "../src/setup/create-flow.js";
import { validateSetupEnvironment } from "../src/setup/profile.js";

describe("setup create flow", () => {
  it("builds create-run modal with kit custom id", () => {
    const modal = setupCreateRunModal("user-1", "create");
    expect(modal.data.custom_id).toBe("setup:create-run:create:user-1");
    expect(modal.data.title).toBe("Setup create");
  });

  it("parses create-run modal custom id", () => {
    expect(parseSetupWizardCustomId("setup:create-run:update:user-2")).toEqual({
      kind: "create-run",
      mode: "update",
      userId: "user-2",
    });
    expect(parseSetupWizardCustomId("setup:commands:draft-1")).toBeUndefined();
  });

  it("rejects wizard when install command is empty", () => {
    const pending = pendingFromRunModal({
      mode: "create",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      install: "   ",
      checksRaw: "test=npm test",
    });
    expect(pending.install).toBe("");
  });

  it("validates wizard environment from modal fields", () => {
    const pending = pendingFromRunModal({
      mode: "create",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      install: "npm ci",
      checksRaw: "test=npm test\nbuild=npm run build",
    });
    const envCheck = validateSetupEnvironment({
      install: pending.install,
      start: pending.start,
      checks: pending.checks,
      requiredEnv: [],
      requiredServices: [],
    });
    expect(envCheck).toMatchObject({ ok: true });
  });

  it("rejects wizard environment when install is missing", () => {
    const pending = pendingFromRunModal({
      mode: "create",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      install: "",
      checksRaw: "",
    });
    const envCheck = validateSetupEnvironment({
      install: pending.install,
      start: pending.start,
      checks: pending.checks,
      requiredEnv: [],
      requiredServices: [],
    });
    expect(envCheck).toMatchObject({
      ok: false,
      message: "Environment install command is required.",
    });
  });
});
