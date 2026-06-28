import type { AppConfig } from "../../config.js";
import { getAppConfig } from "../../app-context.js";

/** App config injected at bootstrap via `injectAppConfig` in `createApp`. */
export function getAgentAppConfig(): AppConfig {
  return getAppConfig();
}