import * as v from "valibot";
import {
  DEFAULT_AGENT_MAX_TOOL_FAILURES,
  DEFAULT_AGENT_MAX_VALIDATION_FAILURES,
  DEFAULT_AGENT_SUBMISSION_MAX_ATTEMPTS,
} from "./flue/agent-guardrails.js";
import type { ParsedTaskRequest, TaskRequest } from "./types.js";

const optionalNonEmptyString = v.optional(
  v.pipe(
    v.union([v.string(), v.undefined()]),
    v.transform((value) => {
      if (value === undefined) return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }),
  ),
);

const optionalCsvString = v.optional(
  v.pipe(
    v.union([v.string(), v.undefined()]),
    v.transform((value) => {
      if (value === undefined) return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }),
  ),
);

const positiveIntFromEnv = (defaultValue: number) =>
  v.pipe(
    v.union([v.string(), v.number(), v.undefined()]),
    v.transform((value) => {
      if (value === undefined || value === "") return defaultValue;
      return typeof value === "number" ? value : Number(value);
    }),
    v.integer("Expected an integer"),
    v.minValue(1, "Expected a positive integer"),
  );

const EnvSchema = v.pipe(
  v.object({
    DATABASE_URL: v.pipe(v.string(), v.minLength(1)),
    DISCORD_BOT_TOKEN: v.pipe(v.string(), v.minLength(1)),
    GITHUB_TOKEN: v.pipe(v.string(), v.minLength(1)),
    WORKSPACE_ROOT: v.optional(
      v.pipe(v.string(), v.minLength(1)),
      "/workspaces",
    ),
    MAX_CONCURRENT_TASKS: v.optional(positiveIntFromEnv(3), 3),
    AGENT_MAX_TOOL_FAILURES: v.optional(
      positiveIntFromEnv(DEFAULT_AGENT_MAX_TOOL_FAILURES),
      DEFAULT_AGENT_MAX_TOOL_FAILURES,
    ),
    AGENT_MAX_VALIDATION_FAILURES: v.optional(
      positiveIntFromEnv(DEFAULT_AGENT_MAX_VALIDATION_FAILURES),
      DEFAULT_AGENT_MAX_VALIDATION_FAILURES,
    ),
    AGENT_SUBMISSION_MAX_ATTEMPTS: v.optional(
      positiveIntFromEnv(DEFAULT_AGENT_SUBMISSION_MAX_ATTEMPTS),
      DEFAULT_AGENT_SUBMISSION_MAX_ATTEMPTS,
    ),
    PORT: v.optional(positiveIntFromEnv(3583), 3583),
    THREADCORD_HTTP_BEARER: optionalNonEmptyString,
    WORKSPACE_TTL_DAYS: v.optional(positiveIntFromEnv(14), 14),
    ANTHROPIC_API_KEY: optionalNonEmptyString,
    ANTHROPIC_MODELS: optionalCsvString,
    OPENAI_API_KEY: optionalNonEmptyString,
    OPENAI_MODELS: optionalCsvString,
    PROVIDERS: optionalCsvString,
    NODE_ENV: v.optional(v.string()),
  }),
  v.forward(
    v.check(
      (env) =>
        env.NODE_ENV !== "production" || Boolean(env.THREADCORD_HTTP_BEARER),
      "THREADCORD_HTTP_BEARER is required when NODE_ENV=production",
    ),
    ["THREADCORD_HTTP_BEARER"],
  ),
);

type EnvParsed = v.InferOutput<typeof EnvSchema>;

export interface CustomProviderConfig {
  id: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: string[];
}

export type AppConfig = EnvParsed & {
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = v.parse(EnvSchema, env);
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