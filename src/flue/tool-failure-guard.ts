import type { FlueEvent } from "@flue/runtime";
import { abortAgentWorkForInstance } from "./agent-work-abort.js";

interface InstanceToolGuardState {
  consecutiveFailures: number;
  tripped: boolean;
}

const stateByInstance = new Map<string, InstanceToolGuardState>();

function stateFor(instanceId: string): InstanceToolGuardState {
  let state = stateByInstance.get(instanceId);
  if (!state) {
    state = { consecutiveFailures: 0, tripped: false };
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

/**
 * Records a tool result event. When consecutive failures reach the limit,
 * aborts in-flight Flue work and returns an operator-facing summary.
 */
export async function maybeAbortOnToolFailures(
  event: FlueEvent,
  instanceId: string,
  maxFailures: number,
): Promise<string | undefined> {
  if (event.type !== "tool") return undefined;

  const state = stateFor(instanceId);

  if (!event.isError) {
    state.consecutiveFailures = 0;
    return undefined;
  }

  if (state.tripped) return undefined;

  state.consecutiveFailures += 1;
  if (state.consecutiveFailures < maxFailures) return undefined;

  state.tripped = true;
  const toolName =
    "toolName" in event && typeof event.toolName === "string"
      ? event.toolName
      : "tool";
  const reason = formatToolFailureReason(event.result);

  try {
    await abortAgentWorkForInstance(instanceId);
  } catch (error) {
    console.error("[threadcord] tool failure guard abort failed", error);
  }

  return `Stopped after ${maxFailures} consecutive tool failures (last: ${toolName}${reason ? `: ${reason}` : ""}).`;
}

function formatToolFailureReason(result: unknown): string | undefined {
  if (typeof result === "string" && result.trim().length > 0) {
    return result.trim().slice(0, 240);
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const message = (result as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim().slice(0, 240);
    }
  }
  return undefined;
}