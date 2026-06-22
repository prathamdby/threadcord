import { z } from 'zod';

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional()
);

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_CHANNEL_ID: z.string().min(1),
    GITHUB_TOKEN: z.string().min(1),
    WORKSPACE_ROOT: z.string().min(1).default('/workspaces'),
    MAX_CONCURRENT_TASKS: z.coerce.number().int().positive().default(3),
    ALLOWED_REPOS: z.string().min(1),
    ALLOWED_MODELS: z.string().min(1),
    PORT: z.coerce.number().int().positive().default(3583),
    THREADCORD_HTTP_BEARER: optionalNonEmptyString,
    WORKSPACE_TTL_DAYS: z.coerce.number().int().positive().default(14),
    OPENCODE_GO_BASE_URL: optionalNonEmptyString,
    OPENCODE_GO_API_KEY: optionalNonEmptyString,
    ANTHROPIC_API_KEY: optionalNonEmptyString,
    OPENAI_API_KEY: optionalNonEmptyString,
    THREADCORD_DEFAULT_MODEL: optionalNonEmptyString,
    NODE_ENV: z.string().optional()
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.THREADCORD_HTTP_BEARER) {
      ctx.addIssue({
        code: 'custom',
        path: ['THREADCORD_HTTP_BEARER'],
        message: 'THREADCORD_HTTP_BEARER is required when NODE_ENV=production'
      });
    }
  });

export type AppConfig = z.infer<typeof EnvSchema> & {
  allowedRepos: string[];
  allowedModels: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const config: AppConfig = {
    ...parsed,
    allowedRepos: splitCsv(parsed.ALLOWED_REPOS),
    allowedModels: splitCsv(parsed.ALLOWED_MODELS)
  };
  assertProviderKeysForModels(config);
  return config;
}

export function assertProviderKeysForModels(config: AppConfig): void {
  for (const model of config.allowedModels) {
    const [provider] = model.split('/', 1);
    if (provider === 'anthropic' && !config.ANTHROPIC_API_KEY) {
      throw new Error(`ALLOWED_MODELS includes ${model} but ANTHROPIC_API_KEY is not set`);
    }
    if (provider === 'openai' && !config.OPENAI_API_KEY) {
      throw new Error(`ALLOWED_MODELS includes ${model} but OPENAI_API_KEY is not set`);
    }
    if (provider === 'opencode-go' && !config.OPENCODE_GO_BASE_URL) {
      throw new Error(`ALLOWED_MODELS includes ${model} but OPENCODE_GO_BASE_URL is not set`);
    }
  }
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
