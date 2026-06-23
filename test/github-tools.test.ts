import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { createGitHubTools } from "../src/github/tools.js";

describe("createGitHubTools", () => {
  const [tool] = createGitHubTools("fake-token");

  it("exposes the create-pull-request tool", () => {
    expect(createGitHubTools("fake-token")).toHaveLength(1);
    expect(tool?.name).toBe("create_github_pull_request");
    expect(typeof tool?.run).toBe("function");
  });

  it("uses the current input/run tool shape, not legacy parameters/execute", () => {
    expect(tool).toHaveProperty("input");
    expect(tool).not.toHaveProperty("parameters");
    expect(tool).not.toHaveProperty("execute");
  });

  it("accepts a well-formed pull-request request", () => {
    const parsed = v.parse(tool!.input, {
      owner: "acme",
      repo: "web",
      title: "Add feature",
      head: "feature",
      base: "main",
    });
    expect(parsed.owner).toBe("acme");
    expect(parsed.body).toBeUndefined();
  });

  it("rejects an empty required field", () => {
    expect(() =>
      v.parse(tool!.input, {
        owner: "",
        repo: "web",
        title: "Add feature",
        head: "feature",
        base: "main",
      }),
    ).toThrow();
  });

  it("validates structured output against the declared schema", () => {
    const parsed = v.parse(tool!.output, {
      number: 7,
      url: "https://github.com/acme/web/pull/7",
      state: "open",
    });
    expect(parsed.number).toBe(7);
  });
});
