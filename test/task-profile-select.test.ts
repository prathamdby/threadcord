import { describe, expect, it } from "vitest";
import { buildCustomId } from "../src/discord/ui/index.js";
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
});
