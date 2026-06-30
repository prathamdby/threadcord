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
import { createFlueAgentTurn, PostgresAgentTurnPersistence } from "./agentturn/index.js";

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
    const postgres = await healthcheckPostgres(store);
    return c.json({ ok: postgres, postgres }, postgres ? 200 : 503);
  });

  app.get("/health", async (c) => {
    const postgres = await healthcheckPostgres(store);
    const discord = discordClient.isReady();
    return c.json(
      { ok: postgres && discord, postgres, discord },
      postgres && discord ? 200 : 503,
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

const { app } = await createApp();
export default app;

async function healthcheckPostgres(store: TaskStore): Promise<boolean> {
  try {
    await store.health();
    return true;
  } catch {
    return false;
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

