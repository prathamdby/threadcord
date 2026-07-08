import { describe, expect, it } from "vitest";
import { fixDoubleEscapedString } from "../src/tools/fix-double-escaped-string.js";

describe("fixDoubleEscapedString", () => {
  it("unescapes literal \\n sequences", () => {
    const result = fixDoubleEscapedString("hello\\nworld");
    expect(result.fixed).toBe(true);
    expect(result.text).toContain("\n");
    expect(result.text).toBe("hello\nworld");
  });

  it("leaves plain strings unchanged", () => {
    const result = fixDoubleEscapedString("plain");
    expect(result.fixed).toBe(false);
    expect(result.text).toBe("plain");
  });
});
