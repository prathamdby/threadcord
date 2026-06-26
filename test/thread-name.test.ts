import { describe, expect, it } from "vitest";
import {
  extractTaskInstruction,
  sanitizeDiscordThreadName,
  threadName,
} from "../src/task/thread-name.js";

describe("threadName", () => {
  it("builds a logical default from repo and task id", () => {
    expect(
      threadName(
        "prathamdby/threadcord",
        "5a1cadef-75bd-4a0c-99a6-41d619213228",
      ),
    ).toBe("threadcord-prathamdby-threadcord-5a1cadef");
  });
});

describe("extractTaskInstruction", () => {
  it("returns text after setup profile memory block", () => {
    const prompt = [
      "Task id: x",
      "",
      "Setup profile memory:",
      "# memory",
      "",
      "Fix the login bug",
    ].join("\n");
    expect(extractTaskInstruction(prompt)).toBe("Fix the login bug");
  });

  it("uses last paragraph after memory when memory has blank lines", () => {
    const prompt = [
      "Task id: x",
      "",
      "Setup profile memory:",
      "# Title",
      "",
      "Paragraph one in memory.",
      "",
      "Paragraph two in memory.",
      "",
      "Actual user instruction",
    ].join("\n");
    expect(extractTaskInstruction(prompt)).toBe("Actual user instruction");
  });
});

describe("sanitizeDiscordThreadName", () => {
  it("strips quotes and clamps length", () => {
    expect(sanitizeDiscordThreadName('  "Rename discord threads"  ')).toBe(
      "Rename discord threads",
    );
    const long = "a".repeat(120);
    expect(sanitizeDiscordThreadName(long).length).toBe(100);
  });

  it("falls back when empty", () => {
    expect(sanitizeDiscordThreadName("   ")).toBe("threadcord task");
  });
});
