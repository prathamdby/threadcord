import { describe, expect, it } from "vitest";
import {
  clearPendingUserTurnMessage,
  setPendingUserTurnMessage,
  takePendingUserTurnMessage,
} from "../src/discord/user-turn-message.js";

describe("user turn message queue", () => {
  it("stores and takes a message once", () => {
    setPendingUserTurnMessage("discord:thread:1", "  Hello user  ");
    expect(takePendingUserTurnMessage("discord:thread:1")).toBe("Hello user");
    expect(takePendingUserTurnMessage("discord:thread:1")).toBeUndefined();
  });

  it("ignores blank messages", () => {
    setPendingUserTurnMessage("discord:thread:2", "   ");
    expect(takePendingUserTurnMessage("discord:thread:2")).toBeUndefined();
  });

  it("clears without posting", () => {
    setPendingUserTurnMessage("discord:thread:3", "bye");
    clearPendingUserTurnMessage("discord:thread:3");
    expect(takePendingUserTurnMessage("discord:thread:3")).toBeUndefined();
  });
});