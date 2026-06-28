import type { AppConfig } from "./config.js";

let injectedConfig: AppConfig | undefined;

/** Called once from createApp after loadConfig. */
export function injectAppConfig(config: AppConfig): void {
  injectedConfig = config;
}

export function getAppConfig(): AppConfig {
  if (!injectedConfig) {
    throw new Error("Threadcord app config is not initialized");
  }
  return injectedConfig;
}

/** Test-only reset. */
export function resetAppConfigForTests(): void {
  injectedConfig = undefined;
}