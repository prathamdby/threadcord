import { Hono } from "hono";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { Pool } from "pg";
import type { Client } from "discord.js";
import type { AppConfig } from "./config.js";
import { cacheConfig, loadConfig } from "./config.js";
import { initializeDatabase } from "./db.js";
import { McpStore } from "./mcp/store.js";
import {
  DefaultMcpRegistry,
  setGlobalMcpRegistry,
  type McpRegistry,
} from "./mcp/registry.js";
import { McpRegistryConfigProvider } from "./mcp/registry.js";
import {
  attachDiscordGateway,
  createDiscordClient,
} from "./discord/gateway.js";
import { SessionEventBridgeImpl } from "./discord/session-event-bridge.js";
import type { AgentOsSessionEvent } from "./discord/session-event-bridge.js";
import { DiscordPublisher } from "./discord/publisher.js";
import { SetupOrchestrator } from "./setup/orchestrator.js";
import { SetupStore } from "./setup/store.js";
import { startWorkspaceJanitor } from "./task/janitor.js";
import { TaskOrchestrator } from "./task/orchestrator.js";
import { TaskStore } from "./task/store.js";
import type { AgentEventRecord } from "./agentturn/index.js";
import {
  createAgentOsAgentTurn,
  createAgentOsCredentialsProvider,
  createDurableAgentTurn,
  createDefaultMachineEnvironment,
  DurableConversationLog,
  MemoryEnvironmentIssueStore,
  PostgresAgentTurnPersistence,
  PostgresConversationLogStore,
  PostgresTurnAttemptStore,
  probeSidecar,
  TurnRunner,
  type AgentTurn,
  type MachineEnvironment,
  type SidecarProbeResult,
  AgentOsAgentTurn,
} from "./agentturn/index.js";
import type { GitExecutor } from "./bindings/types.js";
import { execa } from "./task/execa.js";

export interface CreateAppOptions {
  config?: AppConfig;
  pool?: Pool;
  taskStore?: TaskStore;
  setupStore?: SetupStore;
  mcpStore?: McpStore;
  mcpRegistry?: McpRegistry;
  agentTurn?: AgentTurn;
  machineEnvironment?: MachineEnvironment;
  taskOrchestrator?: TaskOrchestrator;
  setupOrchestrator?: SetupOrchestrator;
  discordClient?: Client;
  createDiscordClient?: typeof createDiscordClient;
  attachDiscordGateway?: typeof attachDiscordGateway;
}

export interface HealthRouteDependencies {
  store: TaskStore;
  discordClient: { isReady(): boolean };
  probeSidecar: () => Promise<SidecarProbeResult>;
}

export function mountHealthRoutes(
  app: Hono,
  deps: HealthRouteDependencies,
): void {
  app.get("/health/live", async (c) => {
    const [postgres, agentos] = await Promise.all([
      healthcheckPostgres(deps.store),
      healthcheckAgentOs(deps.probeSidecar),
    ]);
    const ok = postgres && agentos.ok;
    return c.json(
      {
        ok,
        postgres,
        agentos: {
          ok: agentos.ok,
          path: agentos.path,
          arch: agentos.arch,
          version: agentos.version,
          error: agentos.error,
        },
      },
      ok ? 200 : 503,
    );
  });

  app.get("/health", async (c) => {
    const [postgres, agentos] = await Promise.all([
      healthcheckPostgres(deps.store),
      healthcheckAgentOs(deps.probeSidecar),
    ]);
    const discord = deps.discordClient.isReady();
    const ok = postgres && discord && agentos.ok;
    return c.json(
      {
        ok,
        postgres,
        discord,
        agentos: {
          ok: agentos.ok,
          path: agentos.path,
          arch: agentos.arch,
          version: agentos.version,
          error: agentos.error,
        },
      },
      ok ? 200 : 503,
    );
  });
}

export async function createApp(
  options: CreateAppOptions = {},
): Promise<{
  app: Hono;
  config: AppConfig;
  shutdown: () => Promise<void>;
}> {
  const config = options.config ?? loadConfig();
  if (!options.config) {
    cacheConfig(config);
  }
  const pool = options.pool ?? initializeDatabase(config.DATABASE_URL);
  const store = options.taskStore ?? new TaskStore(pool, config.MAX_CONCURRENT_TASKS);
  const setupStore = options.setupStore ?? new SetupStore(pool);
  const mcpStore = options.mcpStore ?? new McpStore(pool);
  const agentTurnPersistence = new PostgresAgentTurnPersistence(pool);
  const conversationLogStore = new PostgresConversationLogStore(pool);
  const turnAttemptStore = new PostgresTurnAttemptStore(pool);
  await Promise.all([
    store.migrate(),
    setupStore.migrate(),
    mcpStore.migrate(),
    agentTurnPersistence.migrate(),
  ]);

  await verifyAgentOsReadiness();

  const mcpRegistry =
    options.mcpRegistry ?? new DefaultMcpRegistry({ store: mcpStore });
  setGlobalMcpRegistry(mcpRegistry);
  await mcpRegistry.warm().catch((error) => {
    console.error("[threadcord] MCP registry warm failed", error);
  });

  const issueStore = new MemoryEnvironmentIssueStore();
  const activeVmCounter = { getCount: (): number => 0 };
  const mcpConfigProvider = new McpRegistryConfigProvider(mcpRegistry);
  const machineEnvironment =
    options.machineEnvironment ??
    createDefaultMachineEnvironment(
      config,
      mcpConfigProvider,
      {
        issueStore,
        resourceSnapshotProvider: {
          getSnapshot: async () => ({
            rssBytes: 0,
            freeMemoryMb: Number.MAX_SAFE_INTEGER,
            freeDiskMb: Number.MAX_SAFE_INTEGER,
            loadAverage: [0, 0, 0] as [number, number, number],
            workspaceSizeBytes: 0,
            sidecarCount: 0,
            activeVmCount: activeVmCounter.getCount(),
          }),
        },
      },
    );
  const conversationLog = new DurableConversationLog(conversationLogStore);
  const turnRunner = new TurnRunner(turnAttemptStore, {
    leaseOwner: process.env.THREADCORD_LEASE_OWNER ?? hostname(),
    turnTimeoutMs: config.TURN_TIMEOUT_MS,
    heartbeatTimeoutMs: config.TURN_HEARTBEAT_TIMEOUT_MS,
    setupInstallTimeoutMs: config.SETUP_INSTALL_TIMEOUT_MS,
    maxAttempts: 3,
  });

  // Mutable bridge handles break the dependency cycle: the agent turn needs to
  // forward session events to the bridge, but the bridge needs the publisher,
  // which is created after the Discord client starts.
  const sessionEventBridge = {
    handle: (_event: AgentOsSessionEvent) => {},
  };
  const rebuildStatusHandle = {
    fn: async (_instanceId: string, _events: AgentEventRecord[]) => {},
  };
  const editMessageHandle = {
    fn: async (_threadId: string, _messageId: string, _content: string) => {},
  };
  const durableSessionEventForwarder = {
    forward: async (_event: AgentOsSessionEvent) => {},
  };

  let innerAgentTurn: AgentOsAgentTurn | undefined;
  const agentTurn =
    options.agentTurn ??
    (() => {
      innerAgentTurn = createAgentOsAgentTurn({
        machineEnvironment,
        logger: {
          log: (level, message, meta) => console.log(level, message, meta),
        },
        nodeModulesPath: resolve(process.cwd(), "node_modules"),
        getCredentials: createAgentOsCredentialsProvider(config),
        piConfig: config,
        onSessionEvent: (event) => {
          void durableSessionEventForwarder.forward(event);
        },
        bindingsHost: {
          githubToken: config.GITHUB_TOKEN,
          discordUserId: config.DISCORD_BOT_USER_ID ?? "",
          postMessage: async (threadId, content) => {
            await sessionEventBridge.handle({
              type: "final_output",
              instanceId: `discord:thread:${threadId}`,
              content,
            });
          },
          editMessage: async (threadId, messageId, content) => {
            await editMessageHandle.fn(threadId, messageId, content);
          },
          environmentIssueStore: issueStore,
          setupStore,
          taskStore: store,
          gitExecutor: createGitExecutor(),
        },
        mcpRegistry,
      }) as AgentOsAgentTurn;

      const durable = createDurableAgentTurn({
        inner: innerAgentTurn,
        turnRunner,
        conversationLog,
        sessionStore: agentTurnPersistence,
        heartbeatTimeoutMs: config.TURN_HEARTBEAT_TIMEOUT_MS,
        onSessionEvent: (event) => {
          sessionEventBridge.handle(event);
        },
        rebuildStatus: async (instanceId, events) => {
          await rebuildStatusHandle.fn(instanceId, events);
        },
        getThreadId: (instanceId) => {
          const prefix = "discord:thread:";
          return instanceId.startsWith(prefix)
            ? instanceId.slice(prefix.length)
            : undefined;
        },
      });

      durableSessionEventForwarder.forward = (event) =>
        durable.onSessionEvent(event);

      return durable;
    })();

  if (innerAgentTurn) {
    activeVmCounter.getCount = () => innerAgentTurn!.getActiveVmCount();
  }

  const orchestrator =
    options.taskOrchestrator ??
    new TaskOrchestrator(
      config,
      store,
      setupStore,
      agentTurn,
      machineEnvironment,
      mcpRegistry,
      mcpConfigProvider,
    );
  const setupOrchestrator =
    options.setupOrchestrator ??
    new SetupOrchestrator(config, setupStore, agentTurn);

  const discordClient =
    options.discordClient ??
    (options.createDiscordClient ?? createDiscordClient)(
      config.DISCORD_BOT_TOKEN,
      config,
    );

  const publisher = new DiscordPublisher(discordClient);
  orchestrator.setMilestonePublisher(async (threadId, content) => {
    await publisher.send(threadId, content);
  });
  orchestrator.setHeaderPublisher(async (threadId, messageId, content) => {
    await publisher.edit(threadId, messageId, content);
  });
  orchestrator.setTypingPublisher(async (threadId) => {
    await publisher.sendTyping(threadId);
  });
  setupOrchestrator.setMilestonePublisher(async (threadId, content) => {
    await publisher.send(threadId, content);
  });
  orchestrator.setThreadRenamer(async (threadId, name) => {
    const channel = await discordClient.channels.fetch(threadId);
    if (!channel?.isThread()) {
      throw new Error(`Discord thread ${threadId} is not a thread`);
    }
    await channel.setName(name);
  });

  const bridge = new SessionEventBridgeImpl({
    callbacks: {
      store,
      setupStore,
      publisher,
      onAgentEnd: async (instanceId) => {
        if (await setupOrchestrator.handleAgentEnd(instanceId)) return;
        await orchestrator.handleAgentEnd(instanceId);
      },
      onAgentFailure: async (instanceId, errorSummary) => {
        if (
          await setupOrchestrator.handleAgentFailure(instanceId, errorSummary)
        )
          return;
        await orchestrator.handleAgentFailure(instanceId, errorSummary);
      },
    },
  });
  sessionEventBridge.handle = (event) => {
    void bridge.handleEvent(event).catch((error) => {
      console.error(
        "[threadcord] session event bridge failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  };
  rebuildStatusHandle.fn = async (instanceId, events) => {
    await bridge.rebuildStatus(instanceId, events);
  };
  editMessageHandle.fn = async (threadId, messageId, content) => {
    await publisher.edit(threadId, messageId, content);
  };

  const timeoutJanitor = setInterval(() => {
    void turnRunner.enforceTimeouts().catch((error) => {
      console.error(
        "[threadcord] turn timeout enforcement failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, 60_000);
  timeoutJanitor.unref?.();

  const janitor = startWorkspaceJanitor({
    store,
    workspaceTtlDays: config.WORKSPACE_TTL_DAYS,
  });

  try {
    await orchestrator.resumeAfterRestart(async (threadId, content) => {
      await publisher.send(threadId, content);
    });
  } catch (error) {
    console.error(
      "[threadcord] resumeAfterRestart failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  const attach = options.attachDiscordGateway;
  if (attach) {
    attach(
      discordClient,
      config,
      orchestrator,
      setupStore,
      setupOrchestrator,
      mcpStore,
      mcpRegistry,
    );
  } else if (!options.discordClient) {
    attachDiscordGateway(
      discordClient,
      config,
      orchestrator,
      setupStore,
      setupOrchestrator,
      mcpStore,
      mcpRegistry,
    );
  }

  const app = new Hono();
  mountHealthRoutes(app, { store, discordClient, probeSidecar });

  return {
    app,
    config,
    shutdown: async () => {
      clearInterval(timeoutJanitor);
      clearInterval(janitor);
      await mcpRegistry.close();
      await pool.end();
    },
  };
}

async function healthcheckPostgres(store: TaskStore): Promise<boolean> {
  try {
    return await store.health();
  } catch {
    return false;
  }
}

async function verifyAgentOsReadiness(): Promise<void> {
  const probe = await healthcheckAgentOs();
  if (!probe.ok) {
    console.error(
      `[threadcord] AgentOS runtime is not ready; health endpoint will report failure: ${probe.error ?? "sidecar probe failed"} (path=${probe.path}, arch=${probe.arch}, executable=${probe.executable})`,
    );
  } else {
    console.log(
      `[threadcord] AgentOS sidecar ready at ${probe.path} (${probe.arch})`,
    );
  }
}

async function healthcheckAgentOs(
  probe: () => Promise<SidecarProbeResult> = probeSidecar,
): Promise<SidecarProbeResult> {
  try {
    return await probe();
  } catch (error) {
    return {
      ok: false,
      path: "",
      executable: false,
      arch: `${process.platform}/${process.arch}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createGitExecutor(): GitExecutor {
  return {
    async run(command, cwd, env) {
      try {
        const stdout = await execa(command[0] ?? "git", command.slice(1), {
          cwd,
          env,
        });
        return { exitCode: 0, stdout, stderr: "" };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
