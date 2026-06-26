import { describe, expect, it, beforeEach } from "vitest";
import type { FlueEvent } from "@flue/runtime";
import {
  clearToolFailureGuard,
  markToolGuardFailureDelivered,
  maybeAbortOnToolFailures,
  resetToolFailureGuardsForTests,
  shouldSkipObserveFailureDelivery,
} from "../src/flue/tool-failure-guard.js";

function toolEvent(
  isError: boolean,
  instanceId = "discord:thread:1",
): FlueEvent {
  return {
    v: 1,
    eventIndex: 1,
    timestamp: "2026-06-26T00:00:00.000Z",
    type: "tool",
    instanceId,
    toolName: "edit",
    isError,
    result: isError ? "oldText not found" : "ok",
  } as FlueEvent;
}

describe("tool failure guard", () => {
  beforeEach(() => {
    resetToolFailureGuardsForTests();
  });

  it("does not trip before the limit", async () => {
    const id = "discord:thread:guard-1";
    for (let i = 0; i < 9; i++) {
      const trip = await maybeAbortOnToolFailures(toolEvent(true, id), id, 10);
      expect(trip).toBeUndefined();
    }
  });

  it("trips on the Nth consecutive failure", async () => {
    const id = "discord:thread:guard-2";
    for (let i = 0; i < 9; i++) {
      await maybeAbortOnToolFailures(toolEvent(true, id), id, 10);
    }
    const trip = await maybeAbortOnToolFailures(toolEvent(true, id), id, 10);
    expect(trip).toMatch(/Stopped after 10 consecutive tool failures/);
    expect(trip).toContain("edit");
  });

  it("includes content-array error text in trip summary", async () => {
    const id = "discord:thread:guard-4";
    for (let i = 0; i < 9; i++) {
      await maybeAbortOnToolFailures(toolEvent(true, id), id, 10);
    }
    const trip = await maybeAbortOnToolFailures(
      {
        ...toolEvent(true, id),
        result: { content: [{ type: "text", text: "command not found" }] },
      } as FlueEvent,
      id,
      10,
    );
    expect(trip).toContain("command not found");
  });

  it("skips duplicate observe failure after guard delivery", async () => {
    const id = "discord:thread:guard-5";
    for (let i = 0; i < 10; i++) {
      await maybeAbortOnToolFailures(toolEvent(true, id), id, 10);
    }
    markToolGuardFailureDelivered(id);
    expect(shouldSkipObserveFailureDelivery(id)).toBe(true);
    clearToolFailureGuard(id);
    expect(shouldSkipObserveFailureDelivery(id)).toBe(false);
  });

  it("resets the streak after a successful tool", async () => {
    const id = "discord:thread:guard-3";
    for (let i = 0; i < 9; i++) {
      await maybeAbortOnToolFailures(toolEvent(true, id), id, 10);
    }
    await maybeAbortOnToolFailures(toolEvent(false, id), id, 10);
    const trip = await maybeAbortOnToolFailures(toolEvent(true, id), id, 10);
    expect(trip).toBeUndefined();
  });
});