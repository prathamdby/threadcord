import type { AppConfig } from "../config.js";

/** Default cap on consecutive tool errors before the turn is aborted. */
export const DEFAULT_AGENT_MAX_TOOL_FAILURES = 10;

/** Default cap on consecutive validation/schema tool errors before the turn is aborted. */
export const DEFAULT_AGENT_MAX_VALIDATION_FAILURES = 3;

export function resolveAgentMaxToolFailures(config: AppConfig): number {
  return config.AGENT_MAX_TOOL_FAILURES;
}

export function resolveAgentMaxValidationFailures(config: AppConfig): number {
  return config.AGENT_MAX_VALIDATION_FAILURES;
}
