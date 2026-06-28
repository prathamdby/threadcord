import type { AppConfig } from "../../config.js";
import { getAppConfig } from "../../app-context.js";

export const THREADCORD_APP_CONFIG_ENV = "THREADCORD_APP_CONFIG" as const;

export function appConfigFromAgentEnv(
  env: Record<string, unknown>,
): AppConfig {
  const raw = env[THREADCORD_APP_CONFIG_ENV];
  if (typeof raw === "string" && raw.length > 0) {
    return JSON.parse(raw) as AppConfig;
  }
  return getAppConfig();
}

export function appConfigEnvValue(config: AppConfig): Record<string, string> {
  return {
    [THREADCORD_APP_CONFIG_ENV]: JSON.stringify(config),
  };
}