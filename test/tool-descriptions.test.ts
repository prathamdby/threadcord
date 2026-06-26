import { describe, expect, it } from "vitest";
import {
  POST_THREAD_MESSAGE_DESCRIPTION,
  POST_THREAD_REPORT_DESCRIPTION,
  createThreadMessageTools,
} from "../src/discord/thread-message-tool.js";
import { createGitHubTools } from "../src/github/tools.js";
import { createSetupTools } from "../src/setup/tools.js";

describe("tool descriptions", () => {
  it("post_thread_message description contains required contract phrases", () => {
    expect(POST_THREAD_MESSAGE_DESCRIPTION).toContain("user-facing");
    expect(POST_THREAD_MESSAGE_DESCRIPTION).toContain("1900");
    expect(POST_THREAD_MESSAGE_DESCRIPTION).toContain("post_thread_report");
    expect(POST_THREAD_MESSAGE_DESCRIPTION).toContain("Markdown renders");
    expect(POST_THREAD_MESSAGE_DESCRIPTION).toContain(
      "never both in the same turn",
    );
  });

  it("post_thread_report description contains required contract phrases", () => {
    expect(POST_THREAD_REPORT_DESCRIPTION).toContain("multi-part");
    expect(POST_THREAD_REPORT_DESCRIPTION).toContain(
      "Each part posts as its own message",
    );
    expect(POST_THREAD_REPORT_DESCRIPTION).toContain("Root cause");
    expect(POST_THREAD_REPORT_DESCRIPTION).toContain("Summary");
    expect(POST_THREAD_REPORT_DESCRIPTION).toContain(
      "never both in the same turn",
    );
  });

  it("create_github_pull_request description contains required contract phrases", () => {
    const tools = createGitHubTools("ghp_test_token_for_description_only");
    const prTool = tools.find((tool) => tool.name === "create_github_pull_request");
    expect(prTool).toBeDefined();
    expect(prTool!.description).toContain("already-pushed");
    expect(prTool!.description).toContain("title");
    expect(prTool!.description).toContain("head");
    expect(prTool!.description).toContain("base");
    expect(prTool!.description).toContain("branch diff");
    expect(prTool!.description).toContain("GITHUB_TOKEN");
  });

  it("save_threadcord_setup_profile description contains required contract phrases", () => {
    const tools = createSetupTools("run-1");
    const saveTool = tools.find(
      (tool) => tool.name === "save_threadcord_setup_profile",
    );
    expect(saveTool).toBeDefined();
    expect(saveTool!.description).toContain("re-runs install");
    expect(saveTool!.description).toContain("every check");
    expect(saveTool!.description).toContain("smoke probe");
    expect(saveTool!.description).toContain("60000");
    expect(saveTool!.description).toContain("secret value");
  });

  it("registers both thread message tools on the coding agent surface", () => {
    const tools = createThreadMessageTools("discord:thread:1");
    expect(tools.map((tool) => tool.name)).toEqual([
      "post_thread_message",
      "post_thread_report",
    ]);
  });
});
