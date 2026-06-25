import { describe, expect, it } from "vitest";
import {
  PROGRESS_ROLL_THRESHOLD,
  clampDiscordContent,
} from "../src/discord/limits.js";

describe("PROGRESS_ROLL_THRESHOLD", () => {
  it("leaves a 64-char safety margin below the 2000-char content limit", () => {
    expect(PROGRESS_ROLL_THRESHOLD).toBe(1936);
  });
});

describe("clampDiscordContent", () => {
  it("returns content unchanged when below the limit", () => {
    expect(clampDiscordContent("hello", 2000)).toBe("hello");
  });

  it("returns content unchanged when exactly at the limit", () => {
    const content = "x".repeat(2000);
    expect(clampDiscordContent(content, 2000)).toBe(content);
  });

  it("truncates over-limit content while preserving start and end", () => {
    const head = "Failed: bash install";
    const middle = "x".repeat(5000);
    const tail = "gyp ERR! find Python";
    const content = `${head}${middle}${tail}`;
    const maxLength = 200;

    const result = clampDiscordContent(content, maxLength);

    expect(result.length).toBeLessThanOrEqual(maxLength);
    expect(result.startsWith(head)).toBe(true);
    expect(result.endsWith(tail)).toBe(true);
    expect(result).toContain("truncated");
  });

  it("handles tiny maxLength without exceeding the budget", () => {
    const result = clampDiscordContent("abcdefghijklmnop", 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });
});
