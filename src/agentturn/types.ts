/**
 * AgentTurn is the top-level facade and primary seam the orchestrators depend on.
 *
 * It exposes a small interface over a deep implementation that composes
 * TurnRunner, MachineEnvironment, and ConversationLog.
 */

export type AgentTurnRole = "coding" | "setup" | "thread-namer";

export interface AgentTurnInput {
  instanceId: string;
  role: AgentTurnRole;
  instruction: string;
  model: string;
  workspacePath: string;
  repo: string;
  baseBranch: string;
  setupProfileRevision: number;
  /** Optional idempotency key (e.g., Discord message id) used to deduplicate turns. */
  idempotencyKey?: string;
  /** Optional guest session environment variables, including model credentials. */
  env?: Record<string, string>;
  /**
   * Optional reconstructed transcript from prior turns in the same session.
   * Used when resuming after a restart or following up so the agent retains
   * conversation context. The inner turn implementation may pass it to the
   * model as a resume preamble or file reference.
   */
  transcript?: string;
}

export type TerminalOutcome = "completed" | "failed" | "cancelled" | "aborted";

export type TurnEvent =
  | {
      type: "turnStarted";
      instanceId: string;
      turnId: string;
      attemptId: string;
    }
  | {
      type: "progress";
      instanceId: string;
      kind: string;
      payload: unknown;
    }
  | {
      type: "terminal";
      instanceId: string;
      outcome: TerminalOutcome;
      summary?: string;
    };

export interface AgentTurn {
  /**
   * Accept or reject a turn before a concurrency slot is consumed. The
   * orchestrator only transitions a task to `running` after the turn is
   * accepted.
   */
  prompt(
    input: AgentTurnInput,
  ): Promise<{ accepted: true } | { accepted: false; reason: string }>;

  /** Cancel a running turn by instance id. */
  cancel(instanceId: string): Promise<void>;

  /**
   * Subscribe to turn lifecycle events. Returns an unsubscribe function.
   */
  onEvent(handler: (event: TurnEvent) => void): () => void;

  /**
   * Reconcile any agent-side state after a process restart. The orchestrator
   * calls this before its own store-level reconciliation.
   */
  resumeAfterRestart(
    notify: (threadId: string, content: string) => Promise<void>,
  ): Promise<void>;
}
