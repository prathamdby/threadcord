import type { FlueEvent } from "@flue/runtime";
import { abortAgentWorkForInstance } from "./agent-work-abort.js";
import { extractContentArrayText } from "../util/extract-text.js";

interface InstanceToolGuardState {
  consecutiveFailures: number;
  consecutiveValidationFailures: number;
  tripped: boolean;
  /** Set after observe-bridge posts operator failure for a guard trip. */
  operatorFailureDelivered?: boolean;
}

const stateByInstance = new Map<string, InstanceToolGuardState>();

function stateFor(instanceId: string): InstanceToolGuardState {
  let state = stateByInstance.get(instanceId);
  if (!state) {
    state = {
      consecutiveFailures: 0,
      consecutiveValidationFailures: 0,
      tripped: false,
    };
    stateByInstance.set(instanceId, state);
  }
  return state;
}

export function clearToolFailureGuard(instanceId: string): void {
  stateByInstance.delete(instanceId);
}

/** Test-only: reset all in-memory guard state. */
export function resetToolFailureGuardsForTests(): void {
  stateByInstance.clear();
}

export function noteAgentTurnBoundary(instanceId: string): void {
  clearToolFailureGuard(instanceId);
}

export function markToolGuardFailureDelivered(instanceId: string): void {
  const state = stateByInstance.get(instanceId);
  if (state) state.operatorFailureDelivered = true;
}

/** Skip a second onAgentFailure when abort already notified the operator. */
export function shouldSkipObserveFailureDelivery(instanceId: string): boolean {
  return stateByInstance.get(instanceId)?.operatorFailureDelivered === true;
}

/** Classify a tool failure result as a schema/input validation error. */
function isValidationFailure(result: unknown): boolean {
  const text = extractResultText(result);
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("validation") ||
    lower.includes("must have required") ||
    lower.includes("invalid_type") ||
    lower.includes("invalid_enum") ||
    lower.includes("invalid literal") ||
    lower.includes("invalid union") ||
    lower.includes("did not match") ||
    (lower.includes("expected") && lower.includes("received"))
  );
}

function extractResultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const fromContent = extractContentArrayText(obj.content);
    if (fromContent) return fromContent;
    if (typeof obj.message === "string") return obj.message;
  }
  if (result instanceof Error) return result.message;
  return undefined;
}

/**
 * Records a tool result event. When consecutive failures reach the limit,
 * aborts in-flight Flue work and returns an operator-facing summary.
 *
 * Validation/schema failures use a shorter threshold (`maxValidationFailures`)
 * to stop error spirals early, while ordinary tool errors use `maxFailures`.
 * A successful tool call resets both streaks.
 */
export async function maybeAbortOnToolFailures(
  event: FlueEvent,
  instanceId: string,
  maxFailures: number,
  maxValidationFailures: number = maxFailures,
): Promise<string | undefined> {
  if (event.type !== "tool") return undefined;

  const state = stateFor(instanceId);

  if (!event.isError) {
    state.consecutiveFailures = 0;
    state.consecutiveValidationFailures = 0;
    return undefined;
  }

  if (state.tripped) return undefined;

  const result = "result" in event ? (event as { result: unknown }).result : undefined;
  const isValidation = isValidationFailure(result);
  if (isValidation) {
    state.consecutiveValidationFailures += 1;
  }
  state.consecutiveFailures += 1;

  // Check the validation threshold first (it's shorter).
  if (
    isValidation &&
    state.consecutiveValidationFailures >= maxValidationFailures &&
    maxValidationFailures <= maxFailures
  ) {
    return await tripGuard(instanceId, state, event, "validation");
  }

  if (state.consecutiveFailures >= maxFailures) {
    return await tripGuard(instanceId, state, event, "generic");
  }

  return undefined;
}

async function tripGuard(
  instanceId: string,
  state: InstanceToolGuardState,
  event: FlueEvent,
  kind: "validation" | "generic",
): Promise<string> {
  state.tripped = true;
  const toolName =
    "toolName" in event && typeof event.toolName === "string"
      ? event.toolName
      : "tool";
  const result = "result" in event ? (event as { result: unknown }).result : undefined;
  const reason = formatToolFailureReason(result);
  const threshold =
    kind === "validation"
      ? state.consecutiveValidationFailures
      : state.consecutiveFailures;

  try {
    await abortAgentWorkForInstance(instanceId);
  } catch (error) {
    console.error("[threadcord] tool failure guard abort failed", error);
  }

  return `Stopped after ${threshold} consecutive ${kind === "validation" ? "validation " : ""}tool failures (last: ${toolName}${reason ? `: ${reason}` : ""}).`;
}

function formatToolFailureReason(result: unknown): string | undefined {
  const text = extractResultText(result);
  if (text) return text.slice(0, 240);
  return undefined;
}
