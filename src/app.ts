import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppConfig } from "./config.js";
import { cacheConfig, loadConfig } from "./config.js";
import { initializeDatabase } from "./db.js";
import { McpStore } from "./mcp/store.js";
import { DefaultMcpRegistry, setGlobalMcpRegistry } from "./mcp/registry.js";
import { startDiscordGateway } from "./discord/gateway.js";
import { registerObserveBridge } from "./discord/observe-bridge.js";
import { DiscordPublisher } from "./discord/publisher.js";
import { SetupOrchestrator } from "./setup/orchestrator.js";
import { SetupStore } from "./setup/store.js";
import { startWorkspaceJanitor } from "./task/janitor.js";
import { TaskOrchestrator } from "./task/orchestrator.js";
import { TaskStore } from "./task/store.js";
import {
  createFlueAgentTurn,
  PostgresAgentTurnPersistence,
  probeSidecar,
} from "./agentturn/index.js";

export async function createApp(): Promise<{
  app: Hono;
  config: AppConfig;
  shutdown: () => Promise<void>;
}> {
  const config = loadConfig();
  cacheConfig(config);
  const pool = initializeDatabase(config.DATABASE_URL);
  registerProviders(config);

  const store = new TaskStore(pool, config.MAX_CONCURRENT_TASKS);
  const setupStore = new SetupStore(pool);
  const mcpStore = new McpStore(pool);
  const agentTurnPersistence = new PostgresAgentTurnPersistence(pool);
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

  const agentTurn = createFlueAgentTurn();
  const orchestrator = new TaskOrchestrator(
    config,
    store,
    setupStore,
    agentTurn,
    undefined,
    mcpRegistry,
  );
  const setupOrchestrator = new SetupOrchestrator(config, setupStore, agentTurn);
  const discordClient = startDiscordGateway(
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

  registerObserveBridge({
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
      ) {
        return;
      }
      await orchestrator.handleAgentFailure(instanceId, errorSummary);
    },
  });

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
      { ok, postgres, agentos: { ok: agentos.ok, path: agentos.path, arch: agentos.arch, version: agentos.version } },
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
        agentos: { ok: agentos.ok, path: agentos.path, arch: agentos.arch, version: agentos.version },
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

  app.route("/", flue());

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

function registerProviders(config: AppConfig): void {
  if (config.ANTHROPIC_API_KEY) {
    registerProvider("anthropic", { apiKey: config.ANTHROPIC_API_KEY });
  }
  if (config.OPENAI_API_KEY) {
    registerProvider("openai", { apiKey: config.OPENAI_API_KEY });
  }
  for (const provider of config.customProviders) {
    registerProvider(provider.id, {
      api: provider.api,
      baseUrl: provider.baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
    });
  }
}

