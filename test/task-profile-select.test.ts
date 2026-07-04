import { describe, expect, it } from "vitest";
import { buildCustomId } from "../src/discord/ui/index.js";
import { buildModelSelectMenu } from "../src/discord/ui/model-select.js";
import {
  buildTaskCreateModal,
  parseTaskCreateModalCustomId,
  taskCreateModalCustomId,
} from "../src/task/profile-select.js";
import type { SetupProfile } from "../src/setup/profile.js";

const readyProfile: SetupProfile = {
  id: "profile-1",
  repo: "owner/repo",
  branch: "main",
  status: "ready",
  revision: 1,
  environment: {
    install: "npm ci",
    start: "",
    checks: { test: "npm test" },
    requiredEnv: [],
    requiredServices: [],
  },
  memoryMarkdown: "",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function modalTextInputIds(
  modal: ReturnType<typeof buildTaskCreateModal>,
): string[] {
  return modal.toJSON().components.flatMap((label) => {
    const input = (label as { component?: { custom_id?: string } }).component;
    return input?.custom_id ? [input.custom_id] : [];
  });
}

function modelSelectOptions(
  modal: ReturnType<typeof buildTaskCreateModal>,
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

describe("task create modal custom ids", () => {
  it("builds and parses the single-step create modal id", () => {
    expect(taskCreateModalCustomId("user-1")).toBe(
      buildCustomId("task", "create", "modal", "user-1"),
    );
    expect(parseTaskCreateModalCustomId("task:create:modal:user-1")).toEqual({
      userId: "user-1",
    });
  });

  it("task create modal excludes install and checks fields", () => {
    const modal = buildTaskCreateModal({
      userId: "user-1",
      profiles: [readyProfile],
      allowedModels: ["anthropic/claude-sonnet-4-5"],
      defaultModel: "anthropic/claude-sonnet-4-5",
    });
    expect(modalTextInputIds(modal)).toEqual([
      "profile",
      "model",
      "instruction",
    ]);
    expect(JSON.stringify(modal.toJSON())).not.toContain("install");
    expect(JSON.stringify(modal.toJSON())).not.toContain("checks");
  });

  it("model select prepends and pre-selects the default model", () => {
    const modal = buildTaskCreateModal({
      userId: "user-1",
      profiles: [readyProfile],
      allowedModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
      defaultModel: "anthropic/claude-sonnet-4-5",
    });
    const options = modelSelectOptions(modal);
    expect(options[0]?.value).toBe("anthropic/claude-sonnet-4-5");
    expect(options.find((o) => o.value === "anthropic/claude-sonnet-4-5")?.default)
      .toBe(true);
    // no duplicate entries after dedupe
    expect(options.filter((o) => o.value === "anthropic/claude-sonnet-4-5")).toHaveLength(1);
  });

  it("model select guarantees the default model even when absent from allowedModels", () => {
    const modal = buildTaskCreateModal({
      userId: "user-1",
      profiles: [readyProfile],
      allowedModels: ["openai/gpt-4o"],
      defaultModel: "anthropic/claude-sonnet-4-5",
    });
    const options = modelSelectOptions(modal);
    expect(options[0]?.value).toBe("anthropic/claude-sonnet-4-5");
    expect(options).toHaveLength(2);
    expect(options.find((o) => o.default === true)?.value).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("throws when a model id exceeds the Discord select option limit", () => {
    const longModel = "x".repeat(101);
    expect(() =>
      buildModelSelectMenu({
        allowedModels: [longModel],
        defaultModel: longModel,
      }),
    ).toThrow(/exceeds Discord.*character select option limit/);
  });
});
