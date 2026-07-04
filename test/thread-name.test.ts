import { describe, expect, it } from "vitest";
import {
  extractTaskInstruction,
  sanitizeDiscordThreadName,
  stripThreadNamePreamble,
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

describe("stripThreadNamePreamble", () => {
  it("passes a clean title through unchanged", () => {
    expect(stripThreadNamePreamble("Fix login redirect loop")).toBe(
      "Fix login redirect loop",
    );
  });

  it("strips the canonical 'Sure, here's the name: …' preamble", () => {
    expect(
      stripThreadNamePreamble("Sure, here's the name: Fix login redirect"),
    ).toBe("Fix login redirect");
  });

  it("strips a single-word opener followed by a colon", () => {
    expect(stripThreadNamePreamble("Sure: Add login retry")).toBe(
      "Add login retry",
    );
  });

  it("strips an opener that is just 'Here is' or 'Here's'", () => {
    expect(stripThreadNamePreamble("Here's a good title: Add login retry")).toBe(
      "Add login retry",
    );
    expect(stripThreadNamePreamble("Here is a title: Add login retry")).toBe(
      "Add login retry",
    );
  });

  it("strips a bare 'Title:' or 'Name:' label", () => {
    expect(stripThreadNamePreamble("Title: Fix login bug")).toBe(
      "Fix login bug",
    );
    expect(stripThreadNamePreamble("Name: Fix login bug")).toBe(
      "Fix login bug",
    );
    expect(stripThreadNamePreamble("Thread name: Fix login bug")).toBe(
      "Fix login bug",
    );
    expect(stripThreadNamePreamble("Thread title: Fix login bug")).toBe(
      "Fix login bug",
    );
  });

  it("strips opener on the first line and falls through to the title line", () => {
    expect(
      stripThreadNamePreamble("Sure, here's the name:\n\nFix login bug"),
    ).toBe("Fix login bug");
  });

  it("falls back to '' when every line is preamble", () => {
    expect(stripThreadNamePreamble("Sure, here's the name:")).toBe("");
    expect(stripThreadNamePreamble("Sure.\n\nOK.")).toBe("");
  });

  it("does not damage a title whose first word is a real English token", () => {
    // "OKR" should not match the OK opener because the lookahead is a letter.
    expect(stripThreadNamePreamble("OKR scoring bug")).toBe("OKR scoring bug");
    // 'Alaska' starts with 'alaska', not in the opener list.
    expect(stripThreadNamePreamble("Alaska timezone support")).toBe(
      "Alaska timezone support",
    );
  });

  it("is case-insensitive", () => {
    expect(
      stripThreadNamePreamble("SURE, HERE'S THE NAME: Fix login bug"),
    ).toBe("Fix login bug");
    expect(stripThreadNamePreamble("ok, sure: Fix login bug")).toBe(
      "Fix login bug",
    );
  });

  it("handles a curly apostrophe in 'Here's'", () => {
    expect(
      stripThreadNamePreamble("Here\u2019s the name: Fix login bug"),
    ).toBe("Fix login bug");
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

  it("strips a small-model preamble and returns the title only", () => {
    expect(
      sanitizeDiscordThreadName(
        "Sure, here's the name: Fix login redirect loop",
      ),
    ).toBe("Fix login redirect loop");
  });

  it("strips a 'Title:' label", () => {
    expect(sanitizeDiscordThreadName("Title: Fix login bug")).toBe(
      "Fix login bug",
    );
  });

  it("handles multi-line preamble with the title on line 2", () => {
    expect(
      sanitizeDiscordThreadName("Here's a good name:\n\nAdd login retry"),
    ).toBe("Add login retry");
  });

  it("falls back when the entire reply is preamble", () => {
    expect(sanitizeDiscordThreadName("Sure, here's the name:")).toBe(
      "threadcord task",
    );
  });

  it("clamps the cleaned title to the Discord limit", () => {
    const long = "a".repeat(120);
    expect(sanitizeDiscordThreadName(`Title: ${long}`).length).toBe(100);
  });
});
