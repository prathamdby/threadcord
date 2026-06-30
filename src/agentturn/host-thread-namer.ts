import { randomUUID } from "node:crypto";
import { extractTaskInstruction, sanitizeDiscordThreadName } from "../task/thread-name.js";
import type {
  AgentTurn,
  AgentTurnInput,
  TerminalOutcome,
  TurnEvent,
} from "./types.js";

export type RenameDiscordThread = (
  threadId: string,
  name: string,
) => Promise<void>;

export interface Logger {
  log(level: string, message: string, meta?: Record<string, unknown>): void;
}

export interface HostThreadNamerOptions {
  /** Configured default model for the thread-namer role. */
  defaultModel: string;
  /** Callback that performs the Discord thread rename. */
  renameThread: RenameDiscordThread;
  /** Wall-clock timeout for each rename attempt. */
  timeoutMs?: number;
  /** Maximum number of rename attempts. */
  maxAttempts?: number;
  /** Optional logger for rename failures. */
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const FALLBACK_THREAD_NAME = "threadcord task";

/**
 * Lightweight host-side AgentTurn implementation for the thread-namer role.
 *
 * It does not start an AgentOS VM, mount a workspace, register bindings, or
 * materialize MCP config. It derives a readable thread name from the task
 * instruction, invokes the Discord rename callback, and emits a terminal
 * event when finished. All failure paths are caught and logged; the rename is
 * best-effort and never throws.
 */
export class HostThreadNamer implements AgentTurn {
  private readonly handlers = new Set<(event: TurnEvent) => void>();
  private readonly options: HostThreadNamerOptions;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: HostThreadNamerOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async prompt(
    input: AgentTurnInput,
  ): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    if (input.role !== "thread-namer") {
      return {
        accepted: false,
        reason: "HostThreadNamer only supports thread-namer role",
      };
    }

    const validation = validateInput(input);
    if (!validation.ok) {
      return { accepted: false, reason: validation.reason };
    }

    const threadId = threadIdFromInstanceId(input.instanceId);
    if (!threadId) {
      return {
        accepted: false,
        reason: "instanceId must be a discord:thread: id",
      };
    }

    const turnId = makeId("turn");
    const attemptId = makeId("attempt");
    this.emit({
      type: "turnStarted",
      instanceId: input.instanceId,
      turnId,
      attemptId,
    });

    // Run the rename asynchronously so prompt() returns immediately and the
    // caller's turn lifecycle / slot release is never blocked.
    void this.runRename(input.instanceId, threadId, input.instruction).catch(
      (error) => {
        const summary = error instanceof Error ? error.message : String(error);
        this.log("error", "host-thread-namer-unexpected-error", {
          instanceId: input.instanceId,
          summary,
        });
        this.emitTerminal(input.instanceId, "failed", summary);
      },
    );

    return { accepted: true };
  }

  async cancel(_instanceId: string): Promise<void> {
    // The rename runs best-effort with no lingering resources; cancel is a no-op.
  }

  onEvent(handler: (event: TurnEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async resumeAfterRestart(
    _notify: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    // Host-side renames are ephemeral; nothing to reconcile after restart.
  }

  private async runRename(
    instanceId: string,
    threadId: string,
    instruction: string,
  ): Promise<void> {
    const extracted = extractTaskInstruction(instruction);
    const name = sanitizeDiscordThreadName(extracted);
    if (!name || name === FALLBACK_THREAD_NAME) {
      this.emitTerminal(instanceId, "completed");
      return;
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await withTimeout(this.timeoutMs, this.options.renameThread(threadId, name));
        this.emitTerminal(instanceId, "completed");
        return;
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        this.log("warn", "host-thread-namer-rename-failed", {
          instanceId,
          attempt,
          summary,
        });
        if (attempt >= this.maxAttempts) {
          this.emitTerminal(instanceId, "failed", summary);
          return;
        }
      }
    }
  }

  private emitTerminal(
    instanceId: string,
    outcome: TerminalOutcome,
    summary?: string,
  ): void {
    const event: TurnEvent =
      summary === undefined
        ? { type: "terminal", instanceId, outcome }
        : { type: "terminal", instanceId, outcome, summary };
    this.emit(event);
  }

  private emit(event: TurnEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        this.log("error", "host-thread-namer-event-handler-failed", {
          instanceId: event.instanceId,
          summary: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private log(
    level: string,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    this.options.logger?.log(level, message, meta);
  }
}

function validateInput(
  input: AgentTurnInput,
): { ok: true } | { ok: false; reason: string } {
  if (!input.instanceId) {
    return { ok: false, reason: "missing instanceId" };
  }
  if (!input.instruction) {
    return { ok: false, reason: "missing instruction" };
  }
  if (!input.model) {
    return { ok: false, reason: "missing model" };
  }
  return { ok: true };
}

function threadIdFromInstanceId(instanceId: string): string | undefined {
  const prefix = "discord:thread:";
  if (instanceId.startsWith(prefix)) {
    return instanceId.slice(prefix.length);
  }
  return undefined;
}

function makeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Thread namer rename timed out"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

export function createHostThreadNamer(
  options: HostThreadNamerOptions,
): HostThreadNamer {
  return new HostThreadNamer(options);
}
