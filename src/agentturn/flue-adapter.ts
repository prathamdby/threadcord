import { dispatch } from "@flue/runtime";
import codingAgent from "../agents/coding.js";
import setupAgent from "../agents/setup.js";
import { abortAgentWorkForInstance } from "../flue/agent-work-abort.js";
import type { DispatchAgentInput } from "../types.js";
import type { AgentTurn, AgentTurnInput, TurnEvent } from "./types.js";

/**
 * Transitional AgentTurn adapter that satisfies the new seam using the
 * existing Flue runtime. This keeps Flue fully operational in production while
 * the orchestrators depend only on the AgentTurn interface.
 *
 * The adapter is intentionally thin: it maps the role-based AgentTurn input
 * to the current Flue agent payloads and isolates the dispatch call. Event
 * routing is still handled by the global observe-bridge during the transition,
 * so onEvent is a no-op stub until the SessionEventBridge slice.
 */
export class FlueAgentTurn implements AgentTurn {
  async prompt(
    input: AgentTurnInput,
  ): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    try {
      switch (input.role) {
        case "coding": {
          const dispatchInput: DispatchAgentInput = {
            kind: "threadcord.turn",
            workspacePath: input.workspacePath,
            model: input.model,
            repo: input.repo,
            baseBranch: input.baseBranch,
            instruction: input.instruction,
          };
          await dispatch(codingAgent, { id: input.instanceId, input: dispatchInput });
          break;
        }
        case "setup": {
          await dispatch(setupAgent, {
            id: input.instanceId,
            input: {
              kind: "threadcord.setup",
              repo: input.repo,
              branch: input.baseBranch,
              workspacePath: input.workspacePath,
            },
          });
          break;
        }
        case "thread-namer": {
          return {
            accepted: false,
            reason: "thread-namer role must use the host-side namer, not Flue dispatch",
          };
        }
        default: {
          const exhaustive: never = input.role;
          throw new Error(`Unsupported AgentTurn role: ${exhaustive}`);
        }
      }
      return { accepted: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { accepted: false, reason };
    }
  }

  async cancel(instanceId: string): Promise<void> {
    await abortAgentWorkForInstance(instanceId);
  }

  onEvent(_handler: (event: TurnEvent) => void): () => void {
    // The observe-bridge still subscribes to Flue events globally. Once the
    // SessionEventBridge slice lands, this adapter will subscribe to observe()
    // and map Flue events to TurnEvent before forwarding them to the handler.
    return () => {};
  }

  async resumeAfterRestart(
    _notify: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    // No agent-side reconciliation needed while we are still backed by Flue.
    // The orchestrator performs store-level reconciliation as before.
  }
}

export function createFlueAgentTurn(): AgentTurn {
  return new FlueAgentTurn();
}
