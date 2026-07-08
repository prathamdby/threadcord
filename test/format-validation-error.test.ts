import { describe, expect, it } from "vitest";
import { formatToolValidationError } from "../src/tools/format-validation-error.js";

describe("formatToolValidationError", () => {
  it("formats multi-issue paths with tool name and resend reminder", () => {
    const message = formatToolValidationError({
      toolName: "skill",
      issues: [
        { path: ["name"], message: "Required" },
        { path: ["page"], message: "Expected number" },
      ],
      requiredReminder: "Required: action, name (for read), optional page.",
    });
    expect(message).toContain("skill validation failed:");
    expect(message).toContain("- name: Required");
    expect(message).toContain("- page: Expected number");
    expect(message).toContain("Do not resend the same payload.");
    expect(message).toContain("call skill again");
  });

  it("uses (root) when path is empty", () => {
    const message = formatToolValidationError({
      toolName: "save_threadcord_setup_profile",
      issues: [{ path: [], message: "install required" }],
      requiredReminder: "Required: environment.install, memoryMarkdown.",
    });
    expect(message).toContain("- (root): install required");
  });
});
