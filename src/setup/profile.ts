import { randomUUID } from "node:crypto";
import { redact } from "../util/redact.js";
import { validateSkillLinkLines } from "./skills.js";

export const SETUP_PROFILE_STATUSES = [
  "running",
  "ready",
  "failed",
  "updating",
] as const;
export type SetupProfileStatus = (typeof SETUP_PROFILE_STATUSES)[number];

export const SETUP_RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type SetupRunStatus = (typeof SETUP_RUN_STATUSES)[number];

export const SETUP_DRAFT_VALIDATION_STATUSES = [
  "unchecked",
  "valid",
  "invalid",
] as const;
export type SetupDraftValidationStatus =
  (typeof SETUP_DRAFT_VALIDATION_STATUSES)[number];

export interface SetupEnvironment {
  install: string;
  start: string;
  checks: Record<string, string>;
  requiredEnv: string[];
  requiredServices: string[];
  /** Skill repo URLs; installed globally under workspace HOME after install. */
  skills?: string[];
}

export interface SetupProfile {
  id: string;
  repo: string;
  branch: string;
  status: SetupProfileStatus;
  revision: number;
  environment: SetupEnvironment;
  memoryMarkdown: string;
  lastRunId?: string;
  errorSummary?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetupRun {
  id: string;
  profileId: string;
  repo: string;
  branch: string;
  model: string;
  workspacePath: string;
  status: SetupRunStatus;
  discordThreadId?: string;
  progressMessageIds?: string[];
  errorSummary?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetupDraft {
  id: string;
  profileId: string;
  discordUserId: string;
  baseRevision: number;
  environment: SetupEnvironment;
  memoryMarkdown: string;
  validationStatus: SetupDraftValidationStatus;
  validationMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface SetupProfileKey {
  repo: string;
  branch: string;
}

const REPO_FORMAT = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const BRANCH_FORMAT =
  /^(?!\/)(?!.*(?:^|\/)\.)(?!.*\.\.)(?!.*\/\/)(?!.*@{)(?!.*\\)(?!.*\s)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<!\/)(?<!\.)$/;
const ENV_NAME_FORMAT = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_VALUE_HINT =
  /(api[_-]?key|token|authorization|password|secret)\s*[:=]|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/i;

export function newSetupId(): string {
  return randomUUID();
}

export function parseSetupProfileKey(
  repo: string,
  branch: string,
): ValidationResult<SetupProfileKey> {
  const normalizedRepo = repo.trim().toLowerCase();
  const normalizedBranch = branch.trim();
  if (!REPO_FORMAT.test(normalizedRepo)) {
    return {
      ok: false,
      message: `Invalid repository format: ${repo}. Expected 'owner/repo'.`,
    };
  }
  if (!BRANCH_FORMAT.test(normalizedBranch)) {
    return {
      ok: false,
      message: `Invalid branch name: ${branch}.`,
    };
  }
  return { ok: true, value: { repo: normalizedRepo, branch: normalizedBranch } };
}

export function validateSetupEnvironment(
  value: unknown,
): ValidationResult<SetupEnvironment> {
  if (!isPlainObject(value)) {
    return { ok: false, message: "Environment JSON must be an object." };
  }
  const install = stringField(value, "install");
  if (!install.ok) return install;
  if (!install.value.trim()) {
    return { ok: false, message: "Environment install command is required." };
  }
  const start = optionalStringField(value, "start");
  if (!start.ok) return start;
  const checks = checksField(value.checks);
  if (!checks.ok) return checks;
  const requiredEnv = stringListField(value.requiredEnv, "requiredEnv");
  if (!requiredEnv.ok) return requiredEnv;
  for (const name of requiredEnv.value) {
    if (!ENV_NAME_FORMAT.test(name)) {
      return {
        ok: false,
        message: `Invalid required environment variable name: ${name}.`,
      };
    }
    if (name.includes("=")) {
      return {
        ok: false,
        message: "Required environment variables must be names, not values.",
      };
    }
  }
  const requiredServices = stringListField(
    value.requiredServices,
    "requiredServices",
  );
  if (!requiredServices.ok) return requiredServices;
  const skills = optionalSkillsField(value.skills);
  if (!skills.ok) return skills;
  const environment: SetupEnvironment = {
    install: install.value.trim(),
    start: start.value.trim(),
    checks: checks.value,
    requiredEnv: [...new Set(requiredEnv.value.map((name) => name.trim()))],
    requiredServices: [
      ...new Set(requiredServices.value.map((service) => service.trim())),
    ],
  };
  if (skills.value.length > 0) {
    environment.skills = skills.value;
  }
  return { ok: true, value: environment };
}

export const SETUP_MEMORY_MAX_CHARS = 60_000;

export const SETUP_MEMORY_APPEND_MAX_CHARS = 4_000;

export function validateSetupMemory(
  value: unknown,
): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, message: "Memory Markdown must be a string." };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, message: "Memory Markdown is required." };
  }
  if (trimmed.length > SETUP_MEMORY_MAX_CHARS) {
    return {
      ok: false,
      message: `Memory Markdown must be ${SETUP_MEMORY_MAX_CHARS} characters or fewer.`,
    };
  }
  if (SECRET_VALUE_HINT.test(trimmed)) {
    return {
      ok: false,
      message: "Memory Markdown appears to contain a secret value.",
    };
  }
  return { ok: true, value: redact(trimmed) };
}

export function validateSetupMemoryAppend(
  value: unknown,
): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, message: "Memory append must be a string." };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, message: "Memory append must be non-empty." };
  }
  if (trimmed.length > SETUP_MEMORY_APPEND_MAX_CHARS) {
    return {
      ok: false,
      message: `Memory append must be ${SETUP_MEMORY_APPEND_MAX_CHARS} characters or fewer.`,
    };
  }
  if (SECRET_VALUE_HINT.test(trimmed)) {
    return {
      ok: false,
      message: "Memory append appears to contain a secret value.",
    };
  }
  return { ok: true, value: redact(trimmed) };
}

export function mergeSetupMemoryMarkdown(
  existing: string,
  append: string,
): ValidationResult<string> {
  const base = existing.trimEnd();
  const block = append.trim();
  const merged = base.length > 0 ? `${base}\n\n${block}` : block;
  return validateSetupMemory(merged);
}

export function validateSetupProfilePayload(input: {
  environment: unknown;
  memoryMarkdown: unknown;
}): ValidationResult<{
  environment: SetupEnvironment;
  memoryMarkdown: string;
}> {
  const environment = validateSetupEnvironment(input.environment);
  if (!environment.ok) return environment;
  const memoryMarkdown = validateSetupMemory(input.memoryMarkdown);
  if (!memoryMarkdown.ok) return memoryMarkdown;
  return {
    ok: true,
    value: {
      environment: environment.value,
      memoryMarkdown: memoryMarkdown.value,
    },
  };
}

export function serializeSetupEnvironment(
  environment: SetupEnvironment,
): string {
  return JSON.stringify(environment, null, 2);
}

function stringField(
  object: Record<string, unknown>,
  key: string,
): ValidationResult<string> {
  const value = object[key];
  if (typeof value !== "string") {
    return { ok: false, message: `Environment ${key} must be a string.` };
  }
  return { ok: true, value };
}

function optionalStringField(
  object: Record<string, unknown>,
  key: string,
): ValidationResult<string> {
  const value = object[key];
  if (value === undefined) return { ok: true, value: "" };
  if (typeof value !== "string") {
    return { ok: false, message: `Environment ${key} must be a string.` };
  }
  return { ok: true, value };
}

function checksField(value: unknown): ValidationResult<Record<string, string>> {
  if (value === undefined) return { ok: true, value: {} };
  if (!isPlainObject(value)) {
    return { ok: false, message: "Environment checks must be an object." };
  }
  const checks: Record<string, string> = {};
  for (const [name, command] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
      return { ok: false, message: `Invalid check name: ${name}.` };
    }
    if (typeof command !== "string") {
      return { ok: false, message: `Check ${name} must be a string.` };
    }
    checks[name] = command.trim();
  }
  return { ok: true, value: checks };
}

function stringListField(
  value: unknown,
  key: string,
): ValidationResult<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: `Environment ${key} must be an array.` };
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      return {
        ok: false,
        message: `Environment ${key} must contain non-empty strings.`,
      };
    }
    if (SECRET_VALUE_HINT.test(item) || item.includes("=")) {
      return {
        ok: false,
        message: `Environment ${key} must not contain secret values.`,
      };
    }
    strings.push(item.trim());
  }
  return { ok: true, value: strings };
}

function optionalSkillsField(value: unknown): ValidationResult<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: "Environment skills must be an array." };
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      return {
        ok: false,
        message: "Environment skills must contain non-empty strings.",
      };
    }
    if (SECRET_VALUE_HINT.test(item)) {
      return {
        ok: false,
        message: "Environment skills must not contain secret values.",
      };
    }
    strings.push(item.trim());
  }
  const unique = [...new Set(strings)];
  const linkCheck = validateSkillLinkLines(unique);
  if (!linkCheck.ok) return linkCheck;
  return { ok: true, value: unique };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
