import type { AppConfig } from "../config.js";
import type { DurabilityConfig } from "@flue/runtime";

/** Default cap on consecutive tool errors before the turn is aborted. */
export const DEFAULT_AGENT_MAX_TOOL_FAILURES = 10;

/** Default Flue submission attempts (initial run + retries after interruption). */
export const DEFAULT_AGENT_SUBMISSION_MAX_ATTEMPTS = 2;

export function resolveAgentMaxToolFailures(config: AppConfig): number {
  return config.AGENT_MAX_TOOL_FAILURES;
}

export function codingAgentDurability(config: AppConfig): DurabilityConfig {
  return {
    timeoutMs: 60 * 60 * 1000,
    maxAttempts: config.AGENT_SUBMISSION_MAX_ATTEMPTS,
  };
}

export function setupAgentDurability(config: AppConfig): DurabilityConfig {
  return {
    timeoutMs: 30 * 60 * 1000,
    maxAttempts: Math.min(3, config.AGENT_SUBMISSION_MAX_ATTEMPTS),
  };
}

export function threadNamerDurability(config: AppConfig): DurabilityConfig {
  return {
    timeoutMs: 90_000,
    maxAttempts: Math.min(2, config.AGENT_SUBMISSION_MAX_ATTEMPTS),
  };
}
