import { describe, expect, it } from "vitest";
import {
  SETUP_MEMORY_APPEND_MAX_CHARS,
  SETUP_MEMORY_MAX_CHARS,
  mergeSetupMemoryMarkdown,
  validateSetupMemoryAppend,
} from "../src/setup/profile.js";

describe("setup memory append validation", () => {
  it("accepts a short append block", () => {
    expect(
      validateSetupMemoryAppend("- Run tests with DATABASE_URL set."),
    ).toEqual({
      ok: true,
      value: "- Run tests with DATABASE_URL set.",
    });
  });

  it("rejects empty and oversize append", () => {
    expect(validateSetupMemoryAppend("   ")).toMatchObject({ ok: false });
    expect(
      validateSetupMemoryAppend("x".repeat(SETUP_MEMORY_APPEND_MAX_CHARS + 1)),
    ).toMatchObject({
      ok: false,
    });
  });

  it("rejects secret-looking append content", () => {
    expect(
      validateSetupMemoryAppend("token=ghp_abcdefghijklmnopqrstuvwxyz"),
    ).toMatchObject({
      ok: false,
    });
  });

  it("merges append into existing memory and enforces total cap", () => {
    const base = "Existing note.";
    const merged = mergeSetupMemoryMarkdown(
      base,
      "## Gotcha\nAlways mock Redis.",
    );
    expect(merged).toEqual({
      ok: true,
      value: "Existing note.\n\n## Gotcha\nAlways mock Redis.",
    });
    const huge = "a".repeat(SETUP_MEMORY_MAX_CHARS);
    expect(mergeSetupMemoryMarkdown(huge, "b")).toMatchObject({ ok: false });
  });
});
