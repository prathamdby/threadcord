import { z } from "zod";
import type { ParsedTaskRequest, TaskRequest } from "./types.js";

const optionalNonEmptyString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, z.string().min(1).optional());

const optionalCsvString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const MIN_PRODUCTION_BEARER_LENGTH = 16;
const FORBIDDEN_PRODUCTION_BEARERS: ReadonlySet<string> = new Set([
  "threadcord-dev-bearer",
]);

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_CHANNEL_ID: z.string().min(1),
    GITHUB_TOKEN: z.string().min(1),
    WORKSPACE_ROOT: z.string().min(1).default("/workspaces"),
    MAX_CONCURRENT_TASKS: z.coerce.number().int().positive().default(3),
    PORT: z.coerce.number().int().positive().default(3583),
    THREADCORD_HTTP_BEARER: optionalNonEmptyString,
    WORKSPACE_TTL_DAYS: z.coerce.number().int().positive().default(14),
    ANTHROPIC_API_KEY: optionalNonEmptyString,
    ANTHROPIC_MODELS: optionalCsvString,
    OPENAI_API_KEY: optionalNonEmptyString,
    OPENAI_MODELS: optionalCsvString,
    PROVIDERS: optionalCsvString,
    NODE_ENV: z.enum(["production", "development", "test"]).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      const bearer = env.THREADCORD_HTTP_BEARER;
      if (!bearer) {
        ctx.addIssue({
          code: "custom",
          path: ["THREADCORD_HTTP_BEARER"],
          message:
            "THREADCORD_HTTP_BEARER is required when NODE_ENV=production. Provide a private bearer token through secret management.",
        });
      } else if (FORBIDDEN_PRODUCTION_BEARERS.has(bearer.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          path: ["THREADCORD_HTTP_BEARER"],
          message:
            "THREADCORD_HTTP_BEARER must not be a known development default when NODE_ENV=production. Provide a private bearer token through secret management.",
        });
      } else if (bearer.length < MIN_PRODUCTION_BEARER_LENGTH) {
        ctx.addIssue({
          code: "custom",
          path: ["THREADCORD_HTTP_BEARER"],
          message: `THREADCORD_HTTP_BEARER must be at least ${MIN_PRODUCTION_BEARER_LENGTH} characters when NODE_ENV=production. Provide a private bearer token through secret management.`,
        });
      }
    }
  });

export interface CustomProviderConfig {
  id: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: string[];
}

export type AppConfig = z.infer<typeof EnvSchema> & {
  anthropicModels: string[];
  openaiModels: string[];
  customProviders: CustomProviderConfig[];
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
  const anthropicModels = splitCsv(parsed.ANTHROPIC_MODELS);
  const openaiModels = splitCsv(parsed.OPENAI_MODELS);
  const customProviders = parseCustomProviders(env, parsed.PROVIDERS);
  const allowedModels = deriveAllowedModels({
    anthropicModels,
    openaiModels,
    customProviders,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    openaiApiKey: parsed.OPENAI_API_KEY,
  });

  const config: AppConfig = {
    ...parsed,
    anthropicModels,
    openaiModels,
    customProviders,
    allowedModels,
    defaultModel: allowedModels[0]!,
  };
  return config;
}

interface AllowedModelsInput {
  anthropicModels: string[];
  openaiModels: string[];
  customProviders: CustomProviderConfig[];
  anthropicApiKey: string | undefined;
  openaiApiKey: string | undefined;
}

export function deriveAllowedModels(input: AllowedModelsInput): string[] {
  const models: string[] = [];

  if (input.anthropicModels.length > 0 && !input.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required when ANTHROPIC_MODELS is set",
    );
  }

  if (input.openaiModels.length > 0 && !input.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required when OPENAI_MODELS is set");
  }

  if (input.anthropicApiKey) {
    if (input.anthropicModels.length === 0) {
      throw new Error(
        "ANTHROPIC_MODELS is required when ANTHROPIC_API_KEY is set",
      );
    }
    for (const modelId of input.anthropicModels) {
      models.push(`anthropic/${modelId}`);
    }
  }

  if (input.openaiApiKey) {
    if (input.openaiModels.length === 0) {
      throw new Error("OPENAI_MODELS is required when OPENAI_API_KEY is set");
    }
    for (const modelId of input.openaiModels) {
      models.push(`openai/${modelId}`);
    }
  }

  for (const provider of input.customProviders) {
    for (const modelId of provider.models) {
      models.push(`${provider.id}/${modelId}`);
    }
  }

  const allowedModels = [...new Set(models)];
  if (allowedModels.length === 0) {
    throw new Error("At least one provider model must be configured");
  }
  return allowedModels;
}

export function providerEnvPrefix(id: string): string {
  return `PROVIDER_${id.replace(/-/g, "_").toUpperCase()}`;
}

export function parseCustomProviders(
  env: NodeJS.ProcessEnv,
  providersCsv?: string,
): CustomProviderConfig[] {
  const ids = [...new Set(splitCsv(providersCsv))];
  return ids.map((id) => parseCustomProvider(env, id));
}

function parseCustomProvider(
  env: NodeJS.ProcessEnv,
  id: string,
): CustomProviderConfig {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`Invalid provider id "${id}"`);
  }

  const prefix = providerEnvPrefix(id);
  const baseUrl = requiredEnv(env, `${prefix}_BASE_URL`, id);
  const api = requiredEnv(env, `${prefix}_API`, id);
  const models = splitCsv(requiredEnv(env, `${prefix}_MODELS`, id));
  if (models.length === 0) {
    throw new Error(`${prefix}_MODELS must not be empty`);
  }

  const apiKey = optionalEnv(env[`${prefix}_API_KEY`]);
  return {
    id,
    baseUrl,
    api,
    models,
    ...(apiKey ? { apiKey } : {}),
  };
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  providerId: string,
): string {
  const value = optionalEnv(env[key]);
  if (!value) {
    throw new Error(`${key} is required for provider "${providerId}"`);
  }
  return value;
}

function optionalEnv(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
