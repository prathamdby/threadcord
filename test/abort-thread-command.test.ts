import { describe, expect, it } from "vitest";
import { parseThreadControlCommand } from "../src/task/abort-thread-task.js";

describe("parseThreadControlCommand", () => {
  it("maps /abort and abort to abort", () => {
    expect(parseThreadControlCommand("/abort")).toBe("abort");
    expect(parseThreadControlCommand("  /ABORT  ")).toBe("abort");
    expect(parseThreadControlCommand("abort")).toBe("abort");
  });

  it("maps /cancel and cancel to cancel", () => {
    expect(parseThreadControlCommand("/cancel")).toBe("cancel");
    expect(parseThreadControlCommand("cancel")).toBe("cancel");
  });
});