import type { PiHostConfig } from "../../src/providers/index.js";
import { loadPiConfig } from "../../src/providers/index.js";

export function anthropicPiConfig(
  overrides: {
    defaultModel?: string;
    modelsJsonRaw?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): PiHostConfig {
  return loadPiConfig({
    defaultModel: overrides.defaultModel ?? "anthropic/claude-sonnet-4-5",
    env: {
      ANTHROPIC_API_KEY: "anthropic",
      ...overrides.env,
    },
    ...overrides,
  });
}

export function opencodeGoPiConfig(
  overrides: {
    defaultModel?: string;
    modelsJsonRaw?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): PiHostConfig {
  return loadPiConfig({
    defaultModel: overrides.defaultModel ?? "opencode-go/deepseek-v4-flash",
    env: {
      OPENCODE_API_KEY: "opencode-secret",
      ...overrides.env,
    },
    ...overrides,
  });
}

export function proxiedAnthropicPiConfig(): PiHostConfig {
  return loadPiConfig({
    defaultModel: "anthropic/claude-sonnet-4-5",
    modelsJsonRaw: JSON.stringify({
      providers: {
        anthropic: { baseUrl: "https://proxy/v1" },
      },
    }),
    env: {
      ANTHROPIC_API_KEY: "anthropic",
    },
  });
}

export const loadConfigBaseEnv = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "discord",
  GITHUB_TOKEN: "github",
  ANTHROPIC_API_KEY: "anthropic",
  DEFAULT_MODEL: "anthropic/claude-sonnet-4-5",
};
