import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { basename, join, resolve } from "node:path";
import {
  AgentOs,
  createHostDirBackend,
  nodeModulesMount,
  type McpServerConfig as AgentOsMcpServerConfig,
} from "@rivet-dev/agentos-core";
import pi from "@agentos-software/pi";
import type { AgentOsSessionEvent } from "../discord/session-event-bridge.js";
import { redact } from "../util/redact.js";
import type { AppConfig } from "../config.js";
import { createCodingToolKit, createSetupToolKit } from "../bindings/toolkits.js";
import { createBindingsHost } from "../bindings/host.js";
import type { BindingsHostDependencies } from "../bindings/host.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { AcpMcpServerConfig } from "../mcp/acp-config.js";
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

export type AgentOsCreateOptions = Parameters<typeof AgentOs.create>[0];

export interface AgentOsFactory {
  create(options: AgentOsCreateOptions): Promise<AgentOs>;
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
  /** Dependencies for constructing Threadcord host bindings (Discord, GitHub, setup, etc.). When provided, toolkits are registered with the AgentOS VM. */
  bindingsHost?: BindingsHostDependencies;
  /** Reads the global MCP registry and materializes the agent-specific config before each prompt. */
  mcpRegistry?: McpRegistry;
  /** Factory for creating the AgentOS instance. Tests can inject a fake factory to verify the options passed to AgentOs.create and to avoid starting a real sidecar. */
  agentOsFactory?: AgentOsFactory;
}

interface ActiveSession {
  sessionId: string;
  turnId: string;
  attemptId: string;
  instanceId: string;
  guestWorkspacePath: string;
  guestCheckoutPath: string;
}

interface InstanceVm {
  agentOs: AgentOs;
  hostWorkspace: string;
}

/**
 * Real AgentOS-backed AgentTurn implementation for coding and setup turns.
 *
 * It creates an AgentOS VM, mounts the workspace, starts a Pi session, sends
 * the prompt, and streams the resulting ACP session events. Terminal events are
 * emitted exactly once. Role-specific toolkits (coding vs setup) are registered
 * and MCP servers are only materialized for coding turns.
 *
 * Host secrets (API keys, tokens) are kept out of captured runtime logs through
 * redaction.
 */
export class AgentOsAgentTurn implements AgentTurn {
  private readonly vms = new Map<string, InstanceVm>();
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly handlers = new Set<(event: TurnEvent) => void>();
  private readonly deps: AgentOsAgentTurnDependencies;

  constructor(deps: AgentOsAgentTurnDependencies = {}) {
    this.deps = deps;
  }

  getActiveVmCount(): number {
    return this.vms.size;
  }

  async prompt(
    input: AgentTurnInput,
  ): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    const validation = validateInput(input);
    if (!validation.ok) {
      return { accepted: false, reason: validation.reason };
    }

    if (input.role === "thread-namer") {
      return {
        accepted: false,
        reason: `AgentOsAgentTurn does not support thread-namer turns yet`,
      };
    }

    let turnStartedEmitted = false;
    try {
      const turnId = makeId("turn");
      const attemptId = makeId("attempt");
      const guestWorkspacePath = "/workspace";
      const guestCheckoutPath = join(guestWorkspacePath, basename(input.repo));

      await this.ensureAgentOs(input);
      const agentOs = this.getAgentOs(input.instanceId);
      if (!agentOs) {
        throw new Error(`AgentOS VM missing for ${input.instanceId}`);
      }

      const mcpServers =
        input.role === "coding"
          ? await this.deps.mcpRegistry?.materializeConfig(
              input.workspacePath,
              input.role,
            ) ?? []
          : [];
      const sessionId = await this.createSession(
        agentOs,
        guestCheckoutPath,
        input,
        mcpServers,
      );
      await agentOs.setSessionModel(sessionId, input.model);
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
      turnStartedEmitted = true;

      // Run the AgentOS session in the background so prompt() returns as soon
      // as the turn has started. The orchestrator commits the task to running
      // after prompt() accepts, and the terminal event is emitted later, when
      // the agent finishes.
      void this.executeSession(input, session).catch((error) => {
        const summary = error instanceof Error ? error.message : String(error);
        this.deps.logger?.log("error", "agentos-session-failed", {
          instanceId: input.instanceId,
          summary,
        });
        this.deps.machineEnvironment?.logResourceSample("end", input.instanceId)
          .catch(() => {});
        this.emitTerminal(input.instanceId, "failed", summary);
      });

      return { accepted: true };
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await this.deps.machineEnvironment?.logResourceSample(
        "end",
        input.instanceId,
      );
      if (!turnStartedEmitted) {
        return { accepted: false, reason: summary };
      }
      this.emitTerminal(input.instanceId, "failed", summary);
      return { accepted: true };
    }
  }

  private async executeSession(
    input: AgentTurnInput,
    session: ActiveSession,
  ): Promise<void> {
    await this.deps.machineEnvironment?.logResourceSample(
      "start",
      input.instanceId,
    );

    const agentOs = this.getAgentOs(input.instanceId);
    if (!agentOs) {
      throw new Error(`AgentOS VM missing for ${input.instanceId}`);
    }

    const unsubscribe = agentOs.onSessionEvent(
      session.sessionId,
      (event) => {
        this.handleAcpEvent(session, event as AgentOsAcpEvent);
      },
    );

    try {
      const result = await agentOs.prompt(
        session.sessionId,
        input.instruction,
      );
      await this.deps.machineEnvironment?.logResourceSample(
        "end",
        input.instanceId,
      );
      const terminal = buildTerminalEvent(input.instanceId, result);
      this.emit(terminal);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await this.deps.machineEnvironment?.logResourceSample(
        "end",
        input.instanceId,
      );
      this.emitTerminal(input.instanceId, "failed", summary);
    } finally {
      unsubscribe();
      this.sessions.delete(input.instanceId);
      await this.disposeVm(input.instanceId);
    }
  }

  async cancel(instanceId: string): Promise<void> {
    const session = this.sessions.get(instanceId);
    const agentOs = this.getAgentOs(instanceId);
    if (!session || !agentOs) return;
    try {
      await agentOs.cancelSession(session.sessionId);
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
      const agentOs = this.getAgentOs(instanceId);
      try {
        await agentOs?.closeSession(session.sessionId);
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
    await this.disposeAllVms();
  }

  private getAgentOs(instanceId: string): AgentOs | undefined {
    return this.vms.get(instanceId)?.agentOs;
  }

  private async ensureAgentOs(input: AgentTurnInput): Promise<void> {
    const existing = this.vms.get(input.instanceId);
    if (existing && existing.hostWorkspace === input.workspacePath) {
      return;
    }

    if (existing) {
      await this.disposeVm(input.instanceId);
    }

    const sidecarBinPath = this.deps.sidecarBinPath;
    if (sidecarBinPath) {
      process.env.AGENTOS_SIDECAR_BIN = sidecarBinPath;
    }

    const nodeModulesPath =
      this.deps.nodeModulesPath ?? resolve(process.cwd(), "node_modules");

    const toolKits = this.deps.bindingsHost
      ? await buildToolKits(input, this.deps.bindingsHost)
      : [];

    const options: AgentOsCreateOptions = {
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
      toolKits,
      onAgentStderr: (event) => {
        const text = new TextDecoder().decode(event.chunk);
        this.deps.logger?.log("info", "agentos-runtime-log", {
          line: redact(text),
        });
      },
    };
    const agentOs = this.deps.agentOsFactory
      ? await this.deps.agentOsFactory.create(options)
      : await AgentOs.create(options);
    this.vms.set(input.instanceId, {
      agentOs,
      hostWorkspace: input.workspacePath,
    });
  }

  private async disposeVm(instanceId: string): Promise<void> {
    const entry = this.vms.get(instanceId);
    if (!entry) return;
    this.vms.delete(instanceId);
    try {
      await entry.agentOs.dispose();
    } catch (error) {
      this.deps.logger?.log("warn", "agentos-dispose-failed", {
        instanceId,
        summary: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async disposeAllVms(): Promise<void> {
    for (const instanceId of [...this.vms.keys()]) {
      await this.disposeVm(instanceId);
    }
  }

  private async createSession(
    agentOs: AgentOs,
    guestCheckoutPath: string,
    input: AgentTurnInput,
    mcpServers: AcpMcpServerConfig[],
  ): Promise<string> {
    const env: Record<string, string> = {
      ...(input.env ?? {}),
      ...(this.deps.getCredentials?.(input.model) ?? {}),
    };

    const { sessionId } = await agentOs.createSession("pi", {
      cwd: guestCheckoutPath,
      env,
      mcpServers: mcpServers as unknown as AgentOsMcpServerConfig[],
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

async function buildToolKits(
  input: AgentTurnInput,
  deps: BindingsHostDependencies,
): Promise<import("@rivet-dev/agentos-core").ToolKit[]> {
  const host = await createBindingsHost(input, deps);
  if (input.role === "setup") {
    return [createSetupToolKit(host)];
  }
  return [createCodingToolKit(host)];
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

/** Pi guest env var for a provider's API key (matches @mariozechner/pi-ai env-api-keys). */
const PI_GUEST_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  huggingface: "HF_TOKEN",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
};

export function guestApiKeyEnvVarForProvider(providerId: string): string {
  return (
    PI_GUEST_API_KEY_ENV[providerId] ??
    `${providerId.replace(/-/g, "_").toUpperCase()}_API_KEY`
  );
}

/**
 * Build a credentials provider from application config. The model string is
 * expected to be in the form `<provider>/<model-id>`; the provider prefix is
 * mapped to the corresponding Pi guest API key env var.
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
            return {
              [guestApiKeyEnvVarForProvider(custom.id)]: custom.apiKey,
            };
          }
        }
        return {};
      }
    }
  };
}
