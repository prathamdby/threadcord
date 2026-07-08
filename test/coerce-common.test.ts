import { describe, expect, it } from "vitest";
import {
  aliasKeys,
  coercePositiveInt,
  stripWholeStringCodeFence,
  unwrapEnvelope,
} from "../src/tools/coerce-common.js";

describe("unwrapEnvelope", () => {
  it("unwraps payload objects", () => {
    const result = unwrapEnvelope({ payload: { message: "hi" } });
    expect(result.label).toBe("unwrap_payload");
    expect(result.value).toEqual({ message: "hi" });
  });

  it("returns the original object when no envelope", () => {
    const raw = { message: "hi" };
    const result = unwrapEnvelope(raw);
    expect(result.label).toBeUndefined();
    expect(result.value).toBe(raw);
  });
});

describe("aliasKeys", () => {
  it("copies alias to canonical and deletes alias", () => {
    const obj: Record<string, unknown> = { text: "hello" };
    const labels = aliasKeys(obj, [["text", "message"]]);
    expect(obj).toEqual({ message: "hello" });
    expect(labels).toEqual(["alias_text_to_message"]);
  });

  it("prefers canonical when both present", () => {
    const obj: Record<string, unknown> = { message: "a", text: "b" };
    const labels = aliasKeys(obj, [["text", "message"]]);
    expect(obj).toEqual({ message: "a", text: "b" });
    expect(labels).toEqual([]);
  });
});

describe("stripWholeStringCodeFence", () => {
  it("strips a whole-string fenced block", () => {
    const result = stripWholeStringCodeFence("```\nbody\n```");
    expect(result.stripped).toBe(true);
    expect(result.text).toBe("body");
  });

  it("leaves mid-string fences unchanged", () => {
    const s = "see ```code``` here";
    const result = stripWholeStringCodeFence(s);
    expect(result.stripped).toBe(false);
    expect(result.text).toBe(s);
  });
});

describe("coercePositiveInt", () => {
  it('coerces digit string "3" to 3', () => {
    expect(coercePositiveInt("3")).toBe(3);
  });

  it('rejects non-integer digit string "3.5"', () => {
    expect(coercePositiveInt("3.5")).toBeUndefined();
  });

  it("passes through positive integers", () => {
    expect(coercePositiveInt(2)).toBe(2);
  });
});
