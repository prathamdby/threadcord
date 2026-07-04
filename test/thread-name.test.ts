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

  it("strips 'Here's a good title:' and 'Here is a title:' openers", () => {
    expect(
      stripThreadNamePreamble("Here's a good title: Add login retry"),
    ).toBe("Add login retry");
    expect(stripThreadNamePreamble("Here is a title: Add login retry")).toBe(
      "Add login retry",
    );
  });

  it("strips 'Title:' / 'Name:' / 'Thread name:' / 'Thread title:' labels", () => {
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

  it("strips label with article and adjective", () => {
    expect(stripThreadNamePreamble("The great title: Fix login bug")).toBe(
      "Fix login bug",
    );
    expect(
      stripThreadNamePreamble("A great thread name: Fix login bug"),
    ).toBe("Fix login bug");
  });

  it("strips the opener on line 1 and falls through to the title on line 2", () => {
    expect(
      stripThreadNamePreamble("Sure, here's the name:\n\nFix login bug"),
    ).toBe("Fix login bug");
    expect(
      stripThreadNamePreamble("Here's a good name:\n\nAdd login retry"),
    ).toBe("Add login retry");
  });

  it("strips a standalone opener on its own line (no label follows)", () => {
    expect(stripThreadNamePreamble("Sure\n\nOK\n\nFix login bug")).toBe(
      "Fix login bug",
    );
    expect(stripThreadNamePreamble("OK\n\nFix login bug")).toBe(
      "Fix login bug",
    );
    expect(stripThreadNamePreamble("OK.\n\nFix login bug")).toBe(
      "Fix login bug",
    );
    expect(stripThreadNamePreamble("Fine.\n\nFix login bug")).toBe(
      "Fix login bug",
    );
    expect(stripThreadNamePreamble("Got it\n\nFix login bug")).toBe(
      "Fix login bug",
    );
    expect(
      stripThreadNamePreamble("Great.\n\nOK.\n\nFine.\n\nFix login bug"),
    ).toBe("Fix login bug");
  });

  it("falls back to '' when every line is preamble", () => {
    expect(stripThreadNamePreamble("Sure, here's the name:")).toBe("");
    expect(stripThreadNamePreamble("Sure.\n\nOK.")).toBe("");
    expect(stripThreadNamePreamble("OK.\n\n")).toBe("");
  });

  it("preserves titles whose first word is a real English token", () => {
    // "OKR" is not followed by a separator, so the OK opener does not match.
    expect(stripThreadNamePreamble("OKR scoring bug")).toBe("OKR scoring bug");
    // "Alaska" is not in the opener list.
    expect(stripThreadNamePreamble("Alaska timezone support")).toBe(
      "Alaska timezone support",
    );
  });

  it("preserves titles that start with an opener word followed by content", () => {
    // No label follows, so the opener is not stripped.
    expect(stripThreadNamePreamble("Sure thing: Create fix")).toBe(
      "Sure thing: Create fix",
    );
    expect(stripThreadNamePreamble("Sure: Add login retry")).toBe(
      "Sure: Add login retry",
    );
    expect(stripThreadNamePreamble("Great job on the PR")).toBe(
      "Great job on the PR",
    );
    expect(stripThreadNamePreamble("Perfect scenario handling")).toBe(
      "Perfect scenario handling",
    );
  });

  it("preserves 'fine-tune' / 'fine-grained' verb-led titles", () => {
    expect(stripThreadNamePreamble("Fine-tune model parameters")).toBe(
      "Fine-tune model parameters",
    );
    expect(stripThreadNamePreamble("Fine-grained locking fix")).toBe(
      "Fine-grained locking fix",
    );
    expect(stripThreadNamePreamble("Fine tune model parameters")).toBe(
      "Fine tune model parameters",
    );
  });

  it("preserves titles that contain 'name' or 'title' as ordinary words", () => {
    // The LABEL regex requires a real separator (colon, em-dash, etc.) after
    // the label word, so titles where 'name' / 'title' is part of the noun
    // phrase are not damaged.
    expect(
      stripThreadNamePreamble("Thread name normalization service"),
    ).toBe("Thread name normalization service");
    expect(stripThreadNamePreamble("Name service for Kubernetes")).toBe(
      "Name service for Kubernetes",
    );
    expect(stripThreadNamePreamble("Title case formatter")).toBe(
      "Title case formatter",
    );
    expect(stripThreadNamePreamble("A great thread name debate")).toBe(
      "A great thread name debate",
    );
    expect(stripThreadNamePreamble("Name-list rendering bug")).toBe(
      "Name-list rendering bug",
    );
  });

  it("is case-insensitive", () => {
    expect(
      stripThreadNamePreamble("SURE, HERE'S THE NAME: Fix login bug"),
    ).toBe("Fix login bug");
    // Without a label, opener-only preambles are preserved — by design.
    expect(stripThreadNamePreamble("ok, sure: Fix login bug")).toBe(
      "ok, sure: Fix login bug",
    );
  });

  it("handles a curly apostrophe in 'Here's'", () => {
    expect(
      stripThreadNamePreamble("Here\u2019s the name: Fix login bug"),
    ).toBe("Fix login bug");
  });

  it("supports dash and em-dash as label separators (with space before '-')", () => {
    expect(stripThreadNamePreamble("Title - Fix login bug")).toBe(
      "Fix login bug",
    );
    expect(stripThreadNamePreamble("Title—Fix login bug")).toBe(
      "Fix login bug",
    );
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

  it("handles a standalone opener on line 1", () => {
    expect(
      sanitizeDiscordThreadName("Sure\n\nOK\n\nFix login bug"),
    ).toBe("Fix login bug");
    expect(sanitizeDiscordThreadName("OK.\n\nFix login bug")).toBe(
      "Fix login bug",
    );
  });

  it("falls back when the entire reply is preamble", () => {
    expect(sanitizeDiscordThreadName("Sure, here's the name:")).toBe(
      "threadcord task",
    );
  });

  it("preserves a title that starts with an opener word but has no label", () => {
    expect(sanitizeDiscordThreadName("Sure thing: Create fix")).toBe(
      "Sure thing: Create fix",
    );
    expect(sanitizeDiscordThreadName("Fine-tune model parameters")).toBe(
      "Fine-tune model parameters",
    );
  });

  it("preserves a title that contains 'name' / 'title' as a noun", () => {
    expect(
      sanitizeDiscordThreadName("Thread name normalization service"),
    ).toBe("Thread name normalization service");
    expect(sanitizeDiscordThreadName("Title case formatter")).toBe(
      "Title case formatter",
    );
  });

  it("clamps the cleaned title to the Discord limit", () => {
    const long = "a".repeat(120);
    expect(sanitizeDiscordThreadName(`Title: ${long}`).length).toBe(100);
  });
});
