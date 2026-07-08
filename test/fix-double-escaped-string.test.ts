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

  it("does not rewrite Windows path-like backslash-n sequences", () => {
    const path = "C:\\new\\folder";
    const result = fixDoubleEscapedString(path);
    expect(result.fixed).toBe(false);
    expect(result.text).toBe(path);
  });

  it("does not rewrite path-like content inside a longer message", () => {
    const msg = "See C:\\new\\folder for logs";
    const result = fixDoubleEscapedString(msg);
    expect(result.fixed).toBe(false);
    expect(result.text).toBe(msg);
  });
});

  it("does not treat single-quoted wrapping as a JSON string blob", () => {
    // Double-quoted JSON blob would parse to a string without surrounding quotes.
    const doubleQuoted = fixDoubleEscapedString('"hello"');
    expect(doubleQuoted.fixed).toBe(true);
    expect(doubleQuoted.text).toBe("hello");

    // Single-quoted is not valid JSON; leave quotes and do not use the JSON path.
    const singleQuoted = fixDoubleEscapedString("'hello'");
    expect(singleQuoted.text).toBe("'hello'");
  });
