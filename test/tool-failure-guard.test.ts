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

function validationErrorEvent(
  toolName: string,
  instanceId = "discord:thread:1",
  message = "Validation failed: must have required properties",
): FlueEvent {
  return {
    v: 1,
    eventIndex: 1,
    timestamp: "2026-06-26T00:00:00.000Z",
    type: "tool",
    instanceId,
    toolName,
    isError: true,
    result: message,
  } as FlueEvent;
}

describe("tool failure guard", () => {
  beforeEach(() => {
    resetToolFailureGuardsForTests();
  });

  it("does not trip before the limit", async () => {
    const id = "discord:thread:guard-1";
    for (let i = 0; i < 9; i++) {
      const trip = await maybeAbortOnToolFailures(
        toolEvent(true, id),
        id,
        10,
        3,
      );
      expect(trip).toBeUndefined();
    }
  });

  it("trips on the Nth consecutive failure", async () => {
    const id = "discord:thread:guard-2";
    for (let i = 0; i < 9; i++) {
      await maybeAbortOnToolFailures(toolEvent(true, id), id, 10, 3);
    }
    const trip = await maybeAbortOnToolFailures(toolEvent(true, id), id, 10, 3);
    expect(trip).toMatch(/Stopped after 10 consecutive tool failures/);
    expect(trip).toContain("edit");
  });

  it("includes content-array error text in trip summary", async () => {
    const id = "discord:thread:guard-4";
    for (let i = 0; i < 9; i++) {
      await maybeAbortOnToolFailures(toolEvent(true, id), id, 10, 3);
    }
    const trip = await maybeAbortOnToolFailures(
      {
        ...toolEvent(true, id),
        result: { content: [{ type: "text", text: "command not found" }] },
      } as FlueEvent,
      id,
      10,
      3,
    );
    expect(trip).toContain("command not found");
  });

  it("skips duplicate observe failure after guard delivery", async () => {
    const id = "discord:thread:guard-5";
    for (let i = 0; i < 10; i++) {
      await maybeAbortOnToolFailures(toolEvent(true, id), id, 10, 3);
    }
    markToolGuardFailureDelivered(id);
    expect(shouldSkipObserveFailureDelivery(id)).toBe(true);
    clearToolFailureGuard(id);
    expect(shouldSkipObserveFailureDelivery(id)).toBe(false);
  });

  it("resets both streaks after a successful tool", async () => {
    const id = "discord:thread:guard-3";
    for (let i = 0; i < 9; i++) {
      await maybeAbortOnToolFailures(toolEvent(true, id), id, 10, 3);
    }
    await maybeAbortOnToolFailures(toolEvent(false, id), id, 10, 3);
    const trip = await maybeAbortOnToolFailures(toolEvent(true, id), id, 10, 3);
    expect(trip).toBeUndefined();
  });
});

describe("tool failure guard — validation-specific threshold", () => {
  beforeEach(() => {
    resetToolFailureGuardsForTests();
  });

  it("trips at the validation threshold, not the generic threshold", async () => {
    const id = "discord:thread:val-1";
    // 2 validation failures should not trip (threshold is 3).
    await maybeAbortOnToolFailures(validationErrorEvent("glob", id), id, 10, 3);
    await maybeAbortOnToolFailures(validationErrorEvent("bash", id), id, 10, 3);
    // 3rd validation failure should trip.
    const trip = await maybeAbortOnToolFailures(
      validationErrorEvent("read", id),
      id,
      10,
      3,
    );
    expect(trip).toMatch(
      /Stopped after 3 consecutive validation tool failures/,
    );
    expect(trip).toContain("read");
  });

  it("trips on validation failures even when generic count is below generic threshold", async () => {
    const id = "discord:thread:val-2";
    const trip = await maybeAbortOnToolFailures(
      validationErrorEvent("edit", id),
      id,
      10,
      3,
    );
    expect(trip).toBeUndefined();

    await maybeAbortOnToolFailures(validationErrorEvent("edit", id), id, 10, 3);
    const trip3 = await maybeAbortOnToolFailures(
      validationErrorEvent("edit", id),
      id,
      10,
      3,
    );
    expect(trip3).toMatch(/3 consecutive validation tool failures/);
  });

  it("resets validation streak after a successful tool call", async () => {
    const id = "discord:thread:val-3";
    await maybeAbortOnToolFailures(validationErrorEvent("glob", id), id, 10, 3);
    await maybeAbortOnToolFailures(validationErrorEvent("glob", id), id, 10, 3);
    // Success resets both streaks.
    await maybeAbortOnToolFailures(toolEvent(false, id), id, 10, 3);
    // Now 2 more validation failures should not trip.
    await maybeAbortOnToolFailures(validationErrorEvent("glob", id), id, 10, 3);
    const trip = await maybeAbortOnToolFailures(
      validationErrorEvent("glob", id),
      id,
      10,
      3,
    );
    expect(trip).toBeUndefined();
  });

  it("does not count non-validation failures toward the validation streak", async () => {
    const id = "discord:thread:val-4";
    // 5 non-validation failures (generic threshold is 10, validation is 3).
    for (let i = 0; i < 5; i++) {
      const trip = await maybeAbortOnToolFailures(
        toolEvent(true, id),
        id,
        10,
        3,
      );
      expect(trip).toBeUndefined();
    }
    // One validation failure — should not trip because validation streak is 1.
    const trip = await maybeAbortOnToolFailures(
      validationErrorEvent("edit", id),
      id,
      10,
      3,
    );
    expect(trip).toBeUndefined();
  });

  it("detects content-array validation errors", async () => {
    const id = "discord:thread:val-5";
    const validationContentEvent: FlueEvent = {
      ...toolEvent(true, id),
      toolName: "bash",
      result: {
        content: [
          {
            type: "text",
            text: "Validation failed: must have required properties",
          },
        ],
      },
    } as FlueEvent;

    await maybeAbortOnToolFailures(validationContentEvent, id, 10, 3);
    await maybeAbortOnToolFailures(
      { ...validationContentEvent } as FlueEvent,
      id,
      10,
      3,
    );
    const trip = await maybeAbortOnToolFailures(
      { ...validationContentEvent } as FlueEvent,
      id,
      10,
      3,
    );
    expect(trip).toMatch(/3 consecutive validation tool failures/);
  });

  it("detects invalid_type validation errors", async () => {
    const id = "discord:thread:val-6";
    const event: FlueEvent = {
      ...toolEvent(true, id),
      toolName: "write",
      result: "invalid_type: Expected string, received number",
    } as FlueEvent;

    await maybeAbortOnToolFailures(event, id, 10, 3);
    await maybeAbortOnToolFailures({ ...event } as FlueEvent, id, 10, 3);
    const trip = await maybeAbortOnToolFailures(
      { ...event } as FlueEvent,
      id,
      10,
      3,
    );
    expect(trip).toMatch(/validation tool failures/);
  });

  it("does not trip from validation failures when maxValidationFailures equals maxFailures", async () => {
    const id = "discord:thread:val-7";
    // When validation threshold equals generic threshold, behavior is the same.
    for (let i = 0; i < 9; i++) {
      const trip = await maybeAbortOnToolFailures(
        validationErrorEvent("edit", id),
        id,
        10,
        10,
      );
      expect(trip).toBeUndefined();
    }
    const trip = await maybeAbortOnToolFailures(
      validationErrorEvent("edit", id),
      id,
      10,
      10,
    );
    expect(trip).toMatch(/10 consecutive validation tool failures/);
  });

  it("resets validation streak after a non-validation tool failure", async () => {
    const id = "discord:thread:val-8";
    await maybeAbortOnToolFailures(validationErrorEvent("glob", id), id, 10, 3);
    await maybeAbortOnToolFailures(toolEvent(true, id), id, 10, 3);
    await maybeAbortOnToolFailures(validationErrorEvent("glob", id), id, 10, 3);
    await maybeAbortOnToolFailures(toolEvent(true, id), id, 10, 3);
    const trip = await maybeAbortOnToolFailures(
      validationErrorEvent("glob", id),
      id,
      10,
      3,
    );
    expect(trip).toBeUndefined();
  });
});
