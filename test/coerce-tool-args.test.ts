import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coerceToolArgs } from "../src/tools/coerce-tool-args.js";
import { createSkillTools } from "../src/skills/skill-tool.js";

describe("coerceToolArgs", () => {
  it("aliases text to message for post_thread_message", () => {
    const result = coerceToolArgs("post_thread_message", {
      text: "## Summary\\n\\nDone work here with enough body.",
    });
    expect(result.value.message).toBeDefined();
    expect(typeof result.value.message).toBe("string");
    expect(result.value.message as string).toContain("\n");
    expect(result.coercions).toContain("alias_text_to_message");
    expect(result.coercions).toContain("double_escape_fix");
  });

  it("wraps parts string into a one-element array", () => {
    const result = coerceToolArgs("post_thread_report", {
      parts: "## A\n\nbody with enough concrete detail here.",
    });
    expect(Array.isArray(result.value.parts)).toBe(true);
    expect((result.value.parts as string[]).length).toBe(1);
    expect(result.coercions).toContain("parts_string_to_array");
  });

  it("aliases skill mode/skill/page fields", () => {
    const result = coerceToolArgs("skill", {
      mode: "READ",
      skill: "/prath-mode",
      page: "2",
    });
    expect(result.value).toMatchObject({
      action: "read",
      name: "prath-mode",
      page: 2,
    });
  });

  it("aliases PR branch fields", () => {
    const result = coerceToolArgs("create_github_pull_request", {
      owner: "acme",
      repo: "web",
      title: "Add feature",
      branch: "threadcord/feat/x",
      base_branch: "main",
    });
    expect(result.value.head).toBe("threadcord/feat/x");
    expect(result.value.base).toBe("main");
  });

  it("does not invent required message field", () => {
    const result = coerceToolArgs("post_thread_message", {});
    expect(result.value).not.toHaveProperty("message");
    expect(result.coercions).toEqual([]);
  });

  it("returns empty coercions for already-correct shape", () => {
    const result = coerceToolArgs("post_thread_message", {
      message: "## Summary\n\nDone with enough concrete detail for validation.",
    });
    expect(result.coercions).toEqual([]);
  });

  it("prefers canonical message over text alias and drops alias key", () => {
    const result = coerceToolArgs("post_thread_message", {
      message: "a",
      text: "b",
    });
    expect(result.value.message).toBe("a");
    expect(result.value).not.toHaveProperty("text");
  });

  it("does not unwrap envelope when canonical key already present", () => {
    const result = coerceToolArgs("skill", {
      action: "list",
      data: { page: "2" },
    });
    expect(result.value.action).toBe("list");
    expect(result.coercions).not.toContain("unwrap_data");
    // page stays nested; do not invent page at top level
    expect(result.value.page).toBeUndefined();
  });

  it("does not unwrap post_thread_message when message sits beside payload", () => {
    const result = coerceToolArgs("post_thread_message", {
      message: "## Summary\n\nCanonical body with enough detail.",
      payload: { text: "junk" },
    });
    expect(result.value.message).toBe(
      "## Summary\n\nCanonical body with enough detail.",
    );
    expect(result.coercions).not.toContain("unwrap_payload");
  });

  it("aliases append_threadcord_setup_memory text to markdown", () => {
    const result = coerceToolArgs("append_threadcord_setup_memory", {
      text: "stable fact",
    });
    expect(result.value.markdown).toBe("stable fact");
    expect(result.coercions).toContain("alias_text_to_markdown");
  });

  it("aliases save_threadcord_setup_profile memory_markdown", () => {
    const result = coerceToolArgs("save_threadcord_setup_profile", {
      environment: {
        install: "npm i",
        required_env: ["API_KEY"],
        required_services: ["postgres"],
      },
      memory_markdown: "notes",
    });
    expect(result.value.memoryMarkdown).toBe("notes");
    const env = result.value.environment as Record<string, unknown>;
    expect(env.requiredEnv).toEqual(["API_KEY"]);
    expect(env.requiredServices).toEqual(["postgres"]);
  });

  it("returns clone with no transforms for unknown tools", () => {
    const result = coerceToolArgs("bash", { command: "ls" });
    expect(result.value).toEqual({ command: "ls" });
    expect(result.coercions).toEqual([]);
  });

  it("returns empty object for non-object raw", () => {
    expect(coerceToolArgs("skill", null)).toEqual({
      value: {},
      coercions: [],
    });
    expect(coerceToolArgs("skill", "x")).toEqual({
      value: {},
      coercions: [],
    });
  });
});

describe("defineResilientTool prepareArguments", () => {
  it("exposes prepareArguments that aliases skill args", () => {
    const tools = createSkillTools("/tmp", "/tmp");
    const skill = tools.find((t) => t.name === "skill")!;
    expect(
      typeof (skill as { prepareArguments?: unknown }).prepareArguments,
    ).toBe("function");
    const prepared = (
      skill as unknown as { prepareArguments: (a: unknown) => unknown }
    ).prepareArguments({
      mode: "list",
    });
    expect(prepared).toMatchObject({ action: "list" });
  });
});

describe("flue prepareArguments postinstall patch", () => {
  it("forwards prepareArguments from createCustomTools in @flue/runtime dist", () => {
    const dist = join(process.cwd(), "node_modules", "@flue", "runtime", "dist");
    const marker = "prepareArguments: typeof toolDef.prepareArguments";
    const createCustom = "createCustomTools(tools, builtinTools)";
    let foundMarker = false;
    let foundCreate = false;
    for (const file of readdirSync(dist)) {
      if (!file.endsWith(".mjs")) continue;
      const source = readFileSync(join(dist, file), "utf8");
      if (source.includes(createCustom)) foundCreate = true;
      if (source.includes(marker)) foundMarker = true;
    }
    expect(foundCreate).toBe(true);
    expect(foundMarker).toBe(true);
  });
});
