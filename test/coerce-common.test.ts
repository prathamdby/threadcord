import { describe, expect, it } from "vitest";
import {
  ENVELOPE_KEYS,
  aliasKeys,
  coercePositiveInt,
  stripWholeStringCodeFence,
  unwrapEnvelope,
} from "../src/tools/coerce-common.js";

describe("unwrapEnvelope", () => {
  it("unwraps payload objects when sole top-level key", () => {
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

  it("does not unwrap when a preserved canonical key sits beside the envelope", () => {
    const raw = { action: "list", data: { page: "2" } };
    const result = unwrapEnvelope(raw, ENVELOPE_KEYS, {
      preserveIfKeysPresent: ["action", "name"],
    });
    expect(result.label).toBeUndefined();
    expect(result.value).toBe(raw);
  });

  it("unwraps when no preserved keys are present even with junk siblings", () => {
    const result = unwrapEnvelope(
      { payload: { message: "hi" }, junk: 1 },
      ENVELOPE_KEYS,
      { preserveIfKeysPresent: ["message"] },
    );
    expect(result.label).toBe("unwrap_payload");
    expect(result.value).toEqual({ message: "hi" });
  });
});

describe("aliasKeys", () => {
  it("copies alias to canonical and deletes alias", () => {
    const obj: Record<string, unknown> = { text: "hello" };
    const labels = aliasKeys(obj, [["text", "message"]]);
    expect(obj).toEqual({ message: "hello" });
    expect(labels).toEqual(["alias_text_to_message"]);
  });

  it("prefers canonical when both present and drops the alias key", () => {
    const obj: Record<string, unknown> = { message: "a", text: "b" };
    const labels = aliasKeys(obj, [["text", "message"]]);
    expect(obj).toEqual({ message: "a" });
    expect(obj).not.toHaveProperty("text");
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
