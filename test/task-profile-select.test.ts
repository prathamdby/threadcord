import { describe, expect, it } from "vitest";
import { buildCustomId } from "../src/discord/ui/index.js";
import {
  parseTaskCreateModalCustomId,
  taskCreateModalCustomId,
} from "../src/task/profile-select.js";

describe("task create modal custom ids", () => {
  it("builds and parses the single-step create modal id", () => {
    expect(taskCreateModalCustomId("user-1")).toBe(
      buildCustomId("task", "create", "modal", "user-1"),
    );
    expect(parseTaskCreateModalCustomId("task:create:modal:user-1")).toEqual({
      userId: "user-1",
    });
  });
});
