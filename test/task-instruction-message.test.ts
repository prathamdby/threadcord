import { describe, expect, it } from "vitest";
import { formatTaskInstructionForDiscord } from "../src/discord/task-instruction-message.js";

describe("formatTaskInstructionForDiscord", () => {
  it("prefixes trimmed instruction text", () => {
    expect(formatTaskInstructionForDiscord("  fix the bug  ")).toBe(
      "**Task instruction**\nfix the bug",
    );
  });

  it("returns empty for whitespace-only instruction", () => {
    expect(formatTaskInstructionForDiscord("   \n  ")).toBe("");
  });
});