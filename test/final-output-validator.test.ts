import { describe, expect, it } from "vitest";
import { validateFinalOutput } from "../src/discord/final-output-validator.js";

describe("validateFinalOutput", () => {
  describe("accepted outputs", () => {
    it("accepts a concise multi-section message with useful body", () => {
      const content = [
        "## Summary",
        "Fixed the login redirect loop in auth.ts.",
        "",
        "## Verification",
        "Ran npm test — all 12 tests pass.",
      ].join("\n");
      expect(validateFinalOutput(content)).toBeUndefined();
    });

    it("accepts a code-change report with Summary and Changes", () => {
      const content = [
        "## Summary",
        "Added input validation to the signup form.",
        "",
        "## Changes",
        "- src/components/Signup.tsx: added email format check",
        "- src/api/auth.ts: reject invalid emails server-side",
        "",
        "## Verification",
        "Build passes, manual test confirms rejection of bad emails.",
      ].join("\n");
      expect(validateFinalOutput(content)).toBeUndefined();
    });

    it("accepts an investigation report with root cause", () => {
      const content = [
        "## Root cause",
        "The redirect loop occurs because auth.ts:42 checks token before it is set.",
        "",
        "## Evidence",
        "Console log shows token=null at redirect time.",
        "",
        "## Fix sketch",
        "Move the token check after the async setToken call.",
      ].join("\n");
      expect(validateFinalOutput(content)).toBeUndefined();
    });

    it("accepts a short but substantive report", () => {
      const content = [
        "## Summary",
        "Investigated the issue — the bug is in the parser.",
        "",
        "## Outcome",
        "No fix applied yet; needs product decision on approach.",
      ].join("\n");
      expect(validateFinalOutput(content)).toBeUndefined();
    });

    it("accepts a report with code blocks as body content", () => {
      const content = [
        "## Summary",
        "Changed the config loader to use env vars:",
        "```",
        "const port = process.env.PORT ?? 3000;",
        "```",
        "",
        "## Verification",
        "Build passes with the new config approach.",
      ].join("\n");
      expect(validateFinalOutput(content)).toBeUndefined();
    });
  });

  describe("rejected outputs", () => {
    it("rejects ## Summary\\nDone.", () => {
      expect(validateFinalOutput("## Summary\nDone.")).not.toBeUndefined();
    });

    it("rejects a message with only labels and bold text", () => {
      const content = [
        "## Summary",
        "**Done.**",
        "",
        "## Result",
        "**Success.**",
      ].join("\n");
      expect(validateFinalOutput(content)).not.toBeUndefined();
    });

    it("rejects empty content", () => {
      expect(validateFinalOutput("")).not.toBeUndefined();
      expect(validateFinalOutput("   ")).not.toBeUndefined();
    });

    it("rejects content with no ## headers", () => {
      expect(
        validateFinalOutput(
          "Fixed the bug by adding a null check. Tests pass.",
        ),
      ).not.toBeUndefined();
    });

    it("rejects a single header with no body", () => {
      expect(validateFinalOutput("## Summary")).not.toBeUndefined();
    });

    it("rejects a report with only placeholder words", () => {
      const content = ["## Summary", "Done.", "", "## Changes", "None."].join(
        "\n",
      );
      expect(validateFinalOutput(content)).not.toBeUndefined();
    });

    it("rejects a report with only bold labels", () => {
      const content = [
        "## Summary",
        "**Fixed.**",
        "",
        "## Verification",
        "**Passed.**",
      ].join("\n");
      expect(validateFinalOutput(content)).not.toBeUndefined();
    });

    it("rejects substantive preamble before an empty ## section", () => {
      const content =
        "Fixed parser crash and verified the failing input now passes.\n## Summary";
      expect(validateFinalOutput(content)).not.toBeUndefined();
    });
  });
});
