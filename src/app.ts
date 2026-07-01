import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { cacheConfig, loadConfig } from "./config.js";
import { initializeDatabase } from "./db.js";
import { McpStore } from "./mcp/store.js";
import { DefaultMcpRegistry, setGlobalMcpRegistry } from "./mcp/registry.js";
import { McpRegistryConfigProvider } from "./mcp/registry.js";
import { startDiscordGateway } from "./discord/gateway.js";
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
} from "./agentturn/index.js";
import type { GitExecutor } from "./bindings/types.js";
import { execa } from "./task/execa.js";

export async function createApp(): Promise<{
  app: Hono;
  config: AppConfig;
  shutdown: () => Promise<void>;
}> {
  const config = loadConfig();
  cacheConfig(config);
  const pool = initializeDatabase(config.DATABASE_URL);
  const store = new TaskStore(pool, config.MAX_CONCURRENT_TASKS);
  const setupStore = new SetupStore(pool);
  const mcpStore = new McpStore(pool);
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

  const mcpRegistry = new DefaultMcpRegistry({ store: mcpStore });
  setGlobalMcpRegistry(mcpRegistry);
  void mcpRegistry.warm().catch((error) => {
    console.error("[threadcord] MCP registry warm failed", error);
  });

  const issueStore = new MemoryEnvironmentIssueStore();
  const machineEnvironment = createDefaultMachineEnvironment(
    config,
    new McpRegistryConfigProvider(mcpRegistry),
    { issueStore },
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

  const agentTurn = createDurableAgentTurn({
    inner: createAgentOsAgentTurn({
      machineEnvironment,
      logger: {
        log: (level, message, meta) => console.log(level, message, meta),
      },
      nodeModulesPath: resolve(process.cwd(), "node_modules"),
      getCredentials: createAgentOsCredentialsProvider(config),
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
        editMessage: async (threadId, _messageId, content) => {
          // Host bindings currently do not edit existing messages through the bridge.
          await sessionEventBridge.handle({
            type: "final_output",
            instanceId: `discord:thread:${threadId}`,
            content,
          });
        },
        environmentIssueStore: issueStore,
        setupStore,
        taskStore: store,
        gitExecutor: createGitExecutor(),
      },
      mcpRegistry,
    }),
    turnRunner,
    conversationLog,
    sessionStore: agentTurnPersistence,
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

  const orchestrator = new TaskOrchestrator(
    config,
    store,
    setupStore,
    agentTurn,
    machineEnvironment,
    mcpRegistry,
  );
  const setupOrchestrator = new SetupOrchestrator(
    config,
    setupStore,
    agentTurn,
  );
  const discordClient = await startDiscordGateway(
    config.DISCORD_BOT_TOKEN,
    config,
    orchestrator,
    setupStore,
    setupOrchestrator,
    mcpStore,
    mcpRegistry,
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
        if (await setupOrchestrator.handleAgentFailure(instanceId, errorSummary))
          return;
        await orchestrator.handleAgentFailure(instanceId, errorSummary);
      },
    },
    conversationLog,
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

  const janitor = startWorkspaceJanitor({
    store,
    workspaceTtlDays: config.WORKSPACE_TTL_DAYS,
  });

  void orchestrator
    .resumeAfterRestart(async (threadId, content) => {
      await publisher.send(threadId, content);
    })
    .catch((error) => {
      console.error("[threadcord] startup reconciliation failed", error);
    });

  const app = new Hono();

  app.get("/health/live", async (c) => {
    const [postgres, agentos] = await Promise.all([
      healthcheckPostgres(store),
      healthcheckAgentOs(),
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
        },
      },
      ok ? 200 : 503,
    );
  });

  app.get("/health", async (c) => {
    const [postgres, agentos] = await Promise.all([
      healthcheckPostgres(store),
      healthcheckAgentOs(),
    ]);
    const discord = discordClient.isReady();
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
        },
      },
      ok ? 200 : 503,
    );
  });

  const bearer = config.THREADCORD_HTTP_BEARER;
  if (bearer) {
    app.use("/agents/*", bearerAuth(bearer));
    app.use("/workflows/*", bearerAuth(bearer));
    app.use("/runs/*", bearerAuth(bearer));
  }

  return {
    app,
    config,
    shutdown: async () => {
      clearInterval(janitor);
      await mcpRegistry.close();
      await pool.end();
    },
  };
}

async function healthcheckPostgres(store: TaskStore): Promise<boolean> {
  try {
    await store.health();
    return true;
  } catch {
    return false;
  }
}

async function verifyAgentOsReadiness(): Promise<void> {
  const probe = await probeSidecar();
  if (!probe.ok) {
    throw new Error(
      `AgentOS runtime is not ready: ${probe.error ?? "sidecar probe failed"} (path=${probe.path}, arch=${probe.arch}, executable=${probe.executable})`,
    );
  }
  console.log(
    `[threadcord] AgentOS sidecar ready at ${probe.path} (${probe.arch})`,
  );
}

async function healthcheckAgentOs(): Promise<{
  ok: boolean;
  path: string;
  executable: boolean;
  arch: string;
  version?: string | undefined;
  error?: string | undefined;
}> {
  try {
    return await probeSidecar();
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

function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`)
      return c.text("Unauthorized", 401);
    await next();
  };
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
