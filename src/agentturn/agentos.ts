import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { basename, join, resolve } from "node:path";
import {
  AgentOs,
  createHostDirBackend,
  nodeModulesMount,
} from "@rivet-dev/agentos-core";
import pi from "@agentos-software/pi";
import type { AgentOsSessionEvent } from "../discord/session-event-bridge.js";
import { redact } from "../util/redact.js";
import type { AppConfig } from "../config.js";
import type { MachineEnvironment } from "./machine-environment.js";
import type {
  AgentTurn,
  AgentTurnInput,
  TerminalOutcome,
  TurnEvent,
} from "./types.js";
import {
  type AgentOsAcpEvent,
  buildTerminalEvent,
  mapAgentOsEventToBridgeEvent,
} from "./agentos-event-mapper.js";

export interface Logger {
  log(level: string, message: string, meta?: Record<string, unknown>): void;
}

export interface AgentOsAgentTurnDependencies {
  /** Used for start/end resource samples and optional workspace preparation. */
  machineEnvironment?: MachineEnvironment;
  /** Captures redacted AgentOS runtime stderr. */
  logger?: Logger;
  /** Host node_modules path to mount read-only into the VM. */
  nodeModulesPath?: string;
  /** Returns model credentials for the guest session env. */
  getCredentials?: (model: string) => Record<string, string>;
  /** Forward mapped AgentOS session events to the Discord bridge / ConversationLog. */
  onSessionEvent?: (event: AgentOsSessionEvent) => void;
  /** Override the AgentOS sidecar binary path. */
  sidecarBinPath?: string;
}

interface ActiveSession {
  sessionId: string;
  turnId: string;
  attemptId: string;
  instanceId: string;
  guestWorkspacePath: string;
  guestCheckoutPath: string;
}

/**
 * Real AgentOS-backed AgentTurn implementation for coding turns.
 *
 * This is the tracer-bullet implementation: it creates an AgentOS VM, mounts
 * the task workspace, starts a Pi session, sends the prompt, and streams the
 * resulting ACP session events. Terminal events are emitted exactly once.
 *
 * Host secrets (API keys, tokens) are kept out of captured runtime logs through
 * redaction.
 */
export class AgentOsAgentTurn implements AgentTurn {
  private agentOs: AgentOs | undefined;
  private mountedHostWorkspace: string | undefined;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly handlers = new Set<(event: TurnEvent) => void>();
  private readonly deps: AgentOsAgentTurnDependencies;

  constructor(deps: AgentOsAgentTurnDependencies = {}) {
    this.deps = deps;
  }

  async prompt(
    input: AgentTurnInput,
  ): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    const validation = validateInput(input);
    if (!validation.ok) {
      return { accepted: false, reason: validation.reason };
    }

    if (input.role !== "coding") {
      return {
        accepted: false,
        reason: `AgentOsAgentTurn only supports coding turns (got ${input.role})`,
      };
    }

    try {
      const turnId = makeId("turn");
      const attemptId = makeId("attempt");
      const guestWorkspacePath = "/workspace";
      const guestCheckoutPath = join(guestWorkspacePath, basename(input.repo));

      await this.createAgentOs(input);
      const sessionId = await this.createSession(guestCheckoutPath, input);
      const session: ActiveSession = {
        sessionId,
        turnId,
        attemptId,
        instanceId: input.instanceId,
        guestWorkspacePath,
        guestCheckoutPath,
      };
      this.sessions.set(input.instanceId, session);

      this.emit({
        type: "turnStarted",
        instanceId: input.instanceId,
        turnId,
        attemptId,
      });

      await this.deps.machineEnvironment?.logResourceSample(
        "start",
        input.instanceId,
      );

      const unsubscribe = this.agentOs!.onSessionEvent(
        sessionId,
        (event) => {
          this.handleAcpEvent(session, event as AgentOsAcpEvent);
        },
      );

      let result;
      try {
        result = await this.agentOs!.prompt(sessionId, input.instruction);
      } finally {
        unsubscribe();
      }

      await this.deps.machineEnvironment?.logResourceSample(
        "end",
        input.instanceId,
      );

      const terminal = buildTerminalEvent(input.instanceId, result);
      this.emit(terminal);

      return { accepted: true };
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await this.deps.machineEnvironment?.logResourceSample(
        "end",
        input.instanceId,
      );
      this.emitTerminal(input.instanceId, "failed", summary);
      return { accepted: true };
    }
  }

  async cancel(instanceId: string): Promise<void> {
    const session = this.sessions.get(instanceId);
    if (!session || !this.agentOs) return;
    try {
      await this.agentOs.cancelSession(session.sessionId);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      this.deps.logger?.log("warn", "agentos-cancel-failed", {
        instanceId,
        sessionId: session.sessionId,
        summary,
      });
    }
  }

  onEvent(handler: (event: TurnEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async resumeAfterRestart(
    notify: (threadId: string, content: string) => Promise<void>,
  ): Promise<void> {
    for (const [instanceId, session] of this.sessions) {
      try {
        await this.agentOs?.closeSession(session.sessionId);
      } catch (error) {
        this.deps.logger?.log("warn", "agentos-close-on-restart-failed", {
          instanceId,
          sessionId: session.sessionId,
          summary: error instanceof Error ? error.message : String(error),
        });
      }
      const threadId = threadIdFromInstanceId(instanceId);
      if (threadId) {
        try {
          await notify(
            threadId,
            "Resumed after restart. Ready for the next instruction.",
          );
        } catch (error) {
          this.deps.logger?.log("warn", "restart-notification-failed", {
            instanceId,
            threadId,
            summary: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.sessions.clear();
    try {
      await this.agentOs?.dispose();
    } catch (error) {
      this.deps.logger?.log("warn", "agentos-dispose-on-restart-failed", {
        summary: error instanceof Error ? error.message : String(error),
      });
    }
    this.agentOs = undefined;
    this.mountedHostWorkspace = undefined;
  }

  private async createAgentOs(input: AgentTurnInput): Promise<void> {
    if (this.agentOs && this.mountedHostWorkspace === input.workspacePath) {
      return;
    }

    if (this.agentOs) {
      await this.agentOs.dispose();
    }

    const sidecarBinPath = this.deps.sidecarBinPath;
    if (sidecarBinPath) {
      process.env.AGENTOS_SIDECAR_BIN = sidecarBinPath;
    }

    const nodeModulesPath =
      this.deps.nodeModulesPath ?? resolve(process.cwd(), "node_modules");

    this.mountedHostWorkspace = input.workspacePath;
    this.agentOs = await AgentOs.create({
      software: [pi],
      defaultSoftware: true,
      mounts: [
        {
          path: "/workspace",
          plugin: createHostDirBackend({
            hostPath: input.workspacePath,
            readOnly: false,
          }),
          readOnly: false,
        },
        nodeModulesMount(nodeModulesPath, { readOnly: true }),
      ],
      onAgentStderr: (event) => {
        const text = new TextDecoder().decode(event.chunk);
        this.deps.logger?.log("info", "agentos-runtime-log", {
          line: redact(text),
        });
      },
    });
  }

  private async createSession(
    guestCheckoutPath: string,
    input: AgentTurnInput,
  ): Promise<string> {
    const env: Record<string, string> = {
      ...(input.env ?? {}),
      ...(this.deps.getCredentials?.(input.model) ?? {}),
    };

    const { sessionId } = await this.agentOs!.createSession("pi", {
      cwd: guestCheckoutPath,
      env,
      additionalInstructions: "Be concise and follow the task instruction.",
    });
    return sessionId;
  }

  private handleAcpEvent(
    session: ActiveSession,
    event: AgentOsAcpEvent,
  ): void {
    const bridgeEvent = mapAgentOsEventToBridgeEvent(
      session.instanceId,
      session.turnId,
      session.attemptId,
      event,
    );
    if (bridgeEvent) {
      try {
        this.deps.onSessionEvent?.(bridgeEvent);
      } catch (error) {
        this.deps.logger?.log("warn", "agentos-bridge-handler-failed", {
          instanceId: session.instanceId,
          summary: error instanceof Error ? error.message : String(error),
        });
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
        this.deps.logger?.log("error", "agentos-turn-event-handler-failed", {
          instanceId: event.instanceId,
          summary: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function makeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function validateInput(
  input: AgentTurnInput,
): { ok: true } | { ok: false; reason: string } {
  const required: (keyof AgentTurnInput)[] = [
    "instanceId",
    "role",
    "instruction",
    "model",
    "workspacePath",
    "repo",
    "baseBranch",
  ];
  const missing = required.filter((key) => {
    const value = input[key];
    return value === undefined || value === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `missing required AgentTurn input fields: ${missing.join(", ")}`,
    };
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

export function createAgentOsAgentTurn(
  deps?: AgentOsAgentTurnDependencies,
): AgentTurn {
  return new AgentOsAgentTurn(deps);
}

/**
 * Build a credentials provider from application config. The model string is
 * expected to be in the form `<provider>/<model-id>`; the provider prefix is
 * mapped to the corresponding API key env var.
 */
export function createAgentOsCredentialsProvider(
  config: AppConfig,
): (model: string) => Record<string, string> {
  return (model: string) => {
    const provider = model.split("/")[0];
    switch (provider) {
      case "anthropic": {
        return config.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY }
          : {};
      }
      case "openai": {
        return config.OPENAI_API_KEY
          ? { OPENAI_API_KEY: config.OPENAI_API_KEY }
          : {};
      }
      default: {
        for (const custom of config.customProviders) {
          if (custom.id === provider && custom.apiKey) {
            return { [`${provider.toUpperCase()}_API_KEY`]: custom.apiKey };
          }
        }
        return {};
      }
    }
  };
}
