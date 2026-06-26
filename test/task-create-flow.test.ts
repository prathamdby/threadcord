import { describe, expect, it } from "vitest";
import { pendingFromTaskCreateModal } from "../src/task/create-flow.js";

describe("task create flow", () => {
  it("trims pending fields from modal", () => {
    expect(
      pendingFromTaskCreateModal({
        repo: "  owner/repo ",
        branch: " main ",
        model: " anthropic/claude-sonnet-4-5 ",
        instruction: " fix it ",
      }),
    ).toEqual({
      repo: "owner/repo",
      branch: "main",
      model: "anthropic/claude-sonnet-4-5",
      instruction: "fix it",
    });
  });
});
