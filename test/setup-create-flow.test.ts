import { type ModalBuilder } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  parseSetupWizardCustomId,
  pendingFromRunModal,
  setupCreateRunModal,
} from "../src/setup/create-flow.js";
import { validateSetupEnvironment } from "../src/setup/profile.js";

const ALLOWED_MODELS = ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"];
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

function modalComponentCustomIds(modal: ModalBuilder): string[] {
  return modal.toJSON().components.flatMap((label) => {
    const input = (label as { component?: { custom_id?: string } }).component;
    return input?.custom_id ? [input.custom_id] : [];
  });
}

function modalModelOptions(
  modal: ModalBuilder,
): Array<{ value: string; default?: boolean }> {
  for (const label of modal.toJSON().components as Array<{
    component?: {
      custom_id?: string;
      options?: Array<{ value: string; default?: boolean }>;
    };
  }>) {
    if (label.component?.custom_id === "model") {
      return label.component.options ?? [];
    }
  }
  return [];
}

describe("setup create flow", () => {
  it("builds create-run modal with kit custom id", () => {
    const modal = setupCreateRunModal(
      "user-1",
      "create",
      undefined,
      undefined,
      undefined,
      ALLOWED_MODELS,
      DEFAULT_MODEL,
    );
    expect(modal.data.custom_id).toBe("setup:create-run:create:user-1");
    expect(modal.data.title).toBe("Setup create");
  });

  it("create modal asks for repo, branch, skills, and model", () => {
    const modal = setupCreateRunModal(
      "user-1",
      "create",
      undefined,
      undefined,
      undefined,
      ALLOWED_MODELS,
      DEFAULT_MODEL,
    );
    expect(modalComponentCustomIds(modal)).toEqual([
      "repo",
      "branch",
      "skills",
      "model",
    ]);
  });

  it("create modal model select prepends and pre-selects the default model", () => {
    const modal = setupCreateRunModal(
      "user-1",
      "create",
      undefined,
      undefined,
      undefined,
      ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
      DEFAULT_MODEL,
    );
    const options = modalModelOptions(modal);
    expect(options[0]?.value).toBe("anthropic/claude-sonnet-4-5");
    expect(options.find((o) => o.value === "anthropic/claude-sonnet-4-5")?.default)
      .toBe(true);
  });

  it("update modal asks for model, install, and checks within the 5-label cap", () => {
    const modal = setupCreateRunModal(
      "user-1",
      "update",
      undefined,
      undefined,
      undefined,
      ALLOWED_MODELS,
      DEFAULT_MODEL,
    );
    expect(modalComponentCustomIds(modal)).toEqual([
      "repo",
      "branch",
      "skills",
      "model",
      "install",
      "checks",
    ]);
  });

  it("update pending wizard carries the selected model", () => {
    const pending = pendingFromRunModal({
      mode: "update",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      install: "npm ci",
      checksRaw: "test=npm test",
      model: "openai/gpt-4o",
    });
    expect(pending.model).toBe("openai/gpt-4o");
  });

  it("parses create-run modal custom id", () => {
    expect(parseSetupWizardCustomId("setup:create-run:update:user-2")).toEqual({
      kind: "create-run",
      mode: "update",
      userId: "user-2",
    });
    expect(parseSetupWizardCustomId("setup:commands:draft-1")).toBeUndefined();
  });

  it("create pending wizard omits install and checks", () => {
    const pending = pendingFromRunModal({
      mode: "create",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "https://example.com/skill.md",
    });
    expect(pending.install).toBeUndefined();
    expect(pending.checks).toBeUndefined();
    expect(pending.skills).toEqual(["https://example.com/skill.md"]);
  });

  it("create pending wizard carries the selected model", () => {
    const pending = pendingFromRunModal({
      mode: "create",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      model: "openai/gpt-4o",
    });
    expect(pending.model).toBe("openai/gpt-4o");
  });

  it("create pending wizard omits model when blank", () => {
    const pending = pendingFromRunModal({
      mode: "create",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      model: "   ",
    });
    expect(pending.model).toBeUndefined();
  });

  it("update pending wizard parses install and checks", () => {
    const pending = pendingFromRunModal({
      mode: "update",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      install: "npm ci",
      checksRaw: "test=npm test\nbuild=npm run build",
    });
    expect(pending.install).toBe("npm ci");
    expect(pending.checks).toEqual({
      test: "npm test",
      build: "npm run build",
    });
  });

  it("rejects update wizard when install command is empty", () => {
    const pending = pendingFromRunModal({
      mode: "update",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      install: "   ",
      checksRaw: "test=npm test",
    });
    expect(pending.install).toBe("");
  });

  it("validates update wizard environment from modal fields", () => {
    const pending = pendingFromRunModal({
      mode: "update",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      install: "npm ci",
      checksRaw: "test=npm test\nbuild=npm run build",
    });
    const envCheck = validateSetupEnvironment({
      install: pending.install!,
      start: pending.start ?? "",
      checks: pending.checks ?? {},
      requiredEnv: [],
      requiredServices: [],
    });
    expect(envCheck).toMatchObject({ ok: true });
  });

  it("rejects update wizard environment when install is missing", () => {
    const pending = pendingFromRunModal({
      mode: "update",
      repo: "owner/repo",
      branch: "main",
      skillsRaw: "",
      install: "",
      checksRaw: "",
    });
    const envCheck = validateSetupEnvironment({
      install: pending.install ?? "",
      start: pending.start ?? "",
      checks: pending.checks ?? {},
      requiredEnv: [],
      requiredServices: [],
    });
    expect(envCheck).toMatchObject({
      ok: false,
      message: "Environment install command is required.",
    });
  });
});
