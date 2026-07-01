import { z } from "zod";
import {
  DEFAULT_AGENT_MAX_TOOL_FAILURES,
  DEFAULT_AGENT_MAX_VALIDATION_FAILURES,
} from "./discord/agent-guardrails.js";
import type { ParsedTaskRequest, TaskRequest } from "./types.js";
import {
  deriveAllowedModels,
  loadProviderRegistry,
  type ProviderRegistry,
} from "./providers/index.js";

const optionalNonEmptyString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const optionalCsvString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_BOT_USER_ID: optionalNonEmptyString,
    GITHUB_TOKEN: z.string().min(1),
    WORKSPACE_ROOT: z.string().min(1).default("/workspaces"),
    MAX_CONCURRENT_TASKS: z.coerce.number().int().positive().default(3),
    AGENT_MAX_TOOL_FAILURES: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_AGENT_MAX_TOOL_FAILURES),
    AGENT_MAX_VALIDATION_FAILURES: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_AGENT_MAX_VALIDATION_FAILURES),
    PORT: z.coerce.number().int().positive().default(3583),
    WORKSPACE_TTL_DAYS: z.coerce.number().int().positive().default(14),
    MAX_ACTIVE_VMS: z.coerce.number().int().positive().default(2),
    RESERVED_SYSTEM_MEMORY_MB: z.coerce.number().int().positive().default(4096),
    MIN_FREE_DISK_MB: z.coerce.number().int().positive().default(2048),
    AGENTOS_SIDECAR_BIN: optionalNonEmptyString,
    AGENTOS_SANDBOX_ENABLE: z.coerce.boolean().default(false),
    RUNTIME_LOG_LEVEL: z.string().min(1).default("info"),
    TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(3600000),
    TURN_HEARTBEAT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(120000),
    SETUP_INSTALL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(1800000),
    ANTHROPIC_API_KEY: optionalNonEmptyString,
    ANTHROPIC_MODELS: optionalCsvString,
    OPENAI_API_KEY: optionalNonEmptyString,
    OPENAI_MODELS: optionalCsvString,
    PROVIDERS: optionalCsvString,
    NODE_ENV: z.string().optional(),
  });

export type AppConfig = z.infer<typeof EnvSchema> & {
  providerRegistry: ProviderRegistry;
  allowedModels: string[];
  defaultModel: string;
};

export function resolveTaskRequest(
  request: ParsedTaskRequest,
  config: AppConfig,
): TaskRequest {
  return {
    ...request,
    model: request.model ?? config.defaultModel,
  };
}

let runtimeConfig: AppConfig | undefined;

export function cacheConfig(config: AppConfig): void {
  runtimeConfig = config;
}

export function getRuntimeConfig(): AppConfig {
  if (!runtimeConfig) {
    runtimeConfig = loadConfig();
  }
  return runtimeConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const providerRegistry = loadProviderRegistry({
    ...(parsed.ANTHROPIC_API_KEY !== undefined
      ? { anthropicApiKey: parsed.ANTHROPIC_API_KEY }
      : {}),
    ...(parsed.ANTHROPIC_MODELS !== undefined
      ? { anthropicModels: parsed.ANTHROPIC_MODELS }
      : {}),
    ...(parsed.OPENAI_API_KEY !== undefined
      ? { openaiApiKey: parsed.OPENAI_API_KEY }
      : {}),
    ...(parsed.OPENAI_MODELS !== undefined
      ? { openaiModels: parsed.OPENAI_MODELS }
      : {}),
    ...(parsed.PROVIDERS !== undefined ? { providersCsv: parsed.PROVIDERS } : {}),
    env,
  });
  const allowedModels = deriveAllowedModels(providerRegistry);

  const config: AppConfig = {
    ...parsed,
    providerRegistry,
    allowedModels,
    defaultModel: allowedModels[0]!,
  };
  return config;
}
