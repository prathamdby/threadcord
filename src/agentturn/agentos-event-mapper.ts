import { redactPayload } from "./conversation-log.js";
import type { AgentOsSessionEvent } from "../discord/session-event-bridge.js";
import type { TurnEvent } from "./types.js";

/**
 * Raw AgentOS ACP session event shape. AgentOS delivers JSON-RPC
 * notifications; the only method dispatched to session event handlers is
 * `session/update`.
 */
export interface AgentOsAcpEvent {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
}

/**
 * Outcome derived from an AgentOS prompt result response.
 */
export function outcomeFromStopReason(
  stopReason: string | undefined,
): "completed" | "failed" | "cancelled" | "aborted" {
  switch (stopReason) {
    case "end_turn":
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "aborted":
      return "aborted";
    default:
      return "failed";
  }
}

/**
 * Map an AgentOS ACP session notification to the Threadcord session-event
 * bridge taxonomy. The mapping is intentionally conservative: unknown shapes
 * are forwarded as `unknown` so the bridge can render a bounded generic line
 * and never leak raw JSON to Discord.
 */
export function mapAgentOsEventToBridgeEvent(
  instanceId: string,
  turnId: string,
  attemptId: string,
  event: AgentOsAcpEvent,
): AgentOsSessionEvent | undefined {
  if (event.method !== "session/update") return undefined;

  const params = toRecord(event.params);
  const update = toRecord(params.update ?? params);
  const sessionUpdate = update.sessionUpdate;

  if (sessionUpdate === "agent_message_chunk") {
    const content = toRecord(update.content);
    const text = typeof content.text === "string" ? content.text : "";
    return {
      type: "text_delta",
      instanceId,
      turnId,
      attemptId,
      delta: text,
    };
  }

  if (sessionUpdate === "tool_call") {
    const toolCall = toRecord(update.toolCall);
    return {
      type: "tool_start",
      instanceId,
      turnId,
      attemptId,
      toolName: String(toolCall.name ?? "unknown"),
      args: toolCall.arguments ?? toolCall.args ?? {},
      toolCallId: String(toolCall.id ?? "unknown"),
    };
  }

  if (sessionUpdate === "tool_result") {
    const result = toRecord(update.toolResult ?? update.result);
    return {
      type: "tool_result",
      instanceId,
      turnId,
      attemptId,
      toolName: String(result.name ?? "unknown"),
      toolCallId: String(result.id ?? "unknown"),
      isError: Boolean(result.isError ?? result.error),
      result: redactPayload(result.content ?? result.output ?? result),
    };
  }

  return {
    type: "unknown",
    instanceId,
    turnId,
    attemptId,
    rawType: String(sessionUpdate ?? "session/update"),
    payload: redactPayload(update),
  };
}

/**
 * Build a Threadcord `TurnEvent` from an AgentOS prompt result. The result
 * carries the accumulated agent text and the raw JSON-RPC response with a
 * stopReason.
 */
export function buildTerminalEvent(
  instanceId: string,
  result: { response: { result?: unknown }; text: string },
): TurnEvent {
  const stopReason = (result.response.result as { stopReason?: string } | undefined)
    ?.stopReason;
  const outcome = outcomeFromStopReason(stopReason);
  const summary = result.text || `AgentOS stopReason=${stopReason ?? "unknown"}`;
  return {
    type: "terminal",
    instanceId,
    outcome,
    summary,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
