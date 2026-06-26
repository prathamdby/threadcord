import { describe, expect, it } from "vitest";
import {
  parseProfileSelectCustomId,
  parseTaskCreateModalCustomId,
  profileSelectCustomId,
  taskCreateModalCustomId,
} from "../src/task/profile-select.js";

describe("task profile select", () => {
  it("builds and parses profile select custom id", () => {
    expect(profileSelectCustomId("user-1")).toBe("task:sel:profile:user-1");
    expect(parseProfileSelectCustomId("task:sel:profile:user-1")).toEqual({
      userId: "user-1",
    });
  });

  it("builds and parses instruction modal custom id", () => {
    expect(taskCreateModalCustomId("u", "prof")).toBe(
      "task:create:modal:u:prof",
    );
    expect(parseTaskCreateModalCustomId("task:create:modal:u:prof")).toEqual({
      kind: "modal",
      userId: "u",
      profileId: "prof",
    });
  });
});
