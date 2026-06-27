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

  it("returns empty for null or undefined", () => {
    expect(formatTaskInstructionForDiscord(null)).toBe("");
    expect(formatTaskInstructionForDiscord(undefined)).toBe("");
  });

  it("truncates long instructions from the end with ellipsis", () => {
    const long = "x".repeat(2500);
    const formatted = formatTaskInstructionForDiscord(long);
    expect(formatted.length).toBeLessThanOrEqual(2000);
    expect(formatted.endsWith("...")).toBe(true);
    expect(formatted.startsWith("**Task instruction**\n")).toBe(true);
    expect(formatted).not.toContain("[truncated");
  });
});
