import {
  ENVELOPE_KEYS,
  aliasKeys,
  coercePositiveInt,
  stripWholeStringCodeFence,
  trimString,
  unwrapEnvelope,
} from "./coerce-common.js";
import { fixDoubleEscapedString } from "./fix-double-escaped-string.js";
import type { CoerceResult } from "./types.js";

function applyUnwrap(
  obj: Record<string, unknown>,
  coercions: string[],
  preserveIfKeysPresent: readonly string[],
): void {
  const unwrapped = unwrapEnvelope(obj, ENVELOPE_KEYS, {
    preserveIfKeysPresent,
  });
  if (!unwrapped.label) return;
  for (const key of Object.keys(obj)) {
    delete obj[key];
  }
  Object.assign(obj, unwrapped.value);
  coercions.push(unwrapped.label);
}

/** Fence-strip → double-escape fix → trim. Labels listed once per call. */
function cleanStringContent(
  s: string,
): { text: string; labels: string[] } {
  let current = s;
  const labels: string[] = [];
  const fenced = stripWholeStringCodeFence(current);
  if (fenced.stripped) {
    current = fenced.text;
    labels.push("fence_strip");
  }
  const unescaped = fixDoubleEscapedString(current);
  if (unescaped.fixed) {
    current = unescaped.text;
    labels.push("double_escape_fix");
  }
  const trimmed = trimString(current);
  if (trimmed.trimmed) {
    current = trimmed.text;
    labels.push("trim");
  }
  return { text: current, labels };
}

function improveStringField(
  obj: Record<string, unknown>,
  key: string,
  coercions: string[],
): void {
  const value = obj[key];
  if (typeof value !== "string") return;

  const { text, labels } = cleanStringContent(value);
  coercions.push(...labels);
  if (text !== value) {
    obj[key] = text;
  }
}

function coercePostThreadMessage(obj: Record<string, unknown>): string[] {
  const coercions: string[] = [];
  applyUnwrap(obj, coercions, ["message"]);
  coercions.push(
    ...aliasKeys(obj, [
      ["text", "message"],
      ["content", "message"],
      ["body", "message"],
    ]),
  );
  improveStringField(obj, "message", coercions);
  return coercions;
}

function coercePostThreadReport(obj: Record<string, unknown>): string[] {
  const coercions: string[] = [];
  applyUnwrap(obj, coercions, ["parts"]);
  coercions.push(
    ...aliasKeys(obj, [
      ["messages", "parts"],
      ["sections", "parts"],
    ]),
  );
  if (typeof obj.parts === "string" && obj.parts.length > 0) {
    obj.parts = [obj.parts];
    coercions.push("parts_string_to_array");
  }
  if (Array.isArray(obj.parts)) {
    const seenLabels = new Set<string>();
    obj.parts = obj.parts.map((part) => {
      if (typeof part !== "string") return part;
      const { text, labels } = cleanStringContent(part);
      for (const label of labels) {
        if (!seenLabels.has(label)) {
          seenLabels.add(label);
          coercions.push(label);
        }
      }
      return text;
    });
  }
  return coercions;
}


function coerceRepoMap(obj: Record<string, unknown>): string[] {
  const coercions: string[] = [];
  applyUnwrap(obj, coercions, [
    "path",
    "focusFiles",
    "priorityIdents",
    "maxChars",
  ]);
  coercions.push(
    ...aliasKeys(obj, [
      ["subdir", "path"],
      ["directory", "path"],
      ["dir", "path"],
      ["focus", "focusFiles"],
      ["files", "focusFiles"],
      ["focus_files", "focusFiles"],
      ["idents", "priorityIdents"],
      ["identifiers", "priorityIdents"],
      ["symbols", "priorityIdents"],
      ["priority_idents", "priorityIdents"],
      ["max_chars", "maxChars"],
      ["tokenLimit", "maxChars"],
      ["maxTokens", "maxChars"],
    ]),
  );
  if (typeof obj.path === "string") {
    improveStringField(obj, "path", coercions);
  }
  if (typeof obj.focusFiles === "string" && obj.focusFiles.length > 0) {
    obj.focusFiles = [obj.focusFiles];
    coercions.push("focusFiles_string_to_array");
  }
  if (typeof obj.priorityIdents === "string" && obj.priorityIdents.length > 0) {
    obj.priorityIdents = obj.priorityIdents
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    coercions.push("priorityIdents_string_to_array");
  }
  if (Array.isArray(obj.focusFiles)) {
    obj.focusFiles = obj.focusFiles.map((f) =>
      typeof f === "string" ? f.trim() : f,
    );
  }
  if (Array.isArray(obj.priorityIdents)) {
    obj.priorityIdents = obj.priorityIdents.map((f) =>
      typeof f === "string" ? f.trim() : f,
    );
  }
  if ("maxChars" in obj) {
    const n = coercePositiveInt(obj.maxChars);
    if (n !== undefined && n !== obj.maxChars) {
      obj.maxChars = n;
      coercions.push("maxChars_to_int");
    }
  }
  return coercions;
}

function coerceSkill(obj: Record<string, unknown>): string[] {
  const coercions: string[] = [];
  applyUnwrap(obj, coercions, ["action", "name"]);
  coercions.push(
    ...aliasKeys(obj, [
      ["skill", "name"],
      ["skillName", "name"],
      ["id", "name"],
      ["mode", "action"],
    ]),
  );
  if (typeof obj.action === "string") {
    const lower = obj.action.toLowerCase();
    if ((lower === "list" || lower === "read") && obj.action !== lower) {
      obj.action = lower;
      coercions.push("action_lowercase");
    }
  }
  if (typeof obj.name === "string") {
    const original = obj.name;
    const trimmed = original.trim();
    if (trimmed !== original) {
      coercions.push("trim");
    }
    let name = trimmed;
    if (name.startsWith("/")) {
      name = name.slice(1);
      coercions.push("skill_name_slash_strip");
    }
    if (name !== original) {
      obj.name = name;
    }
  }
  if ("page" in obj) {
    const page = coercePositiveInt(obj.page);
    if (page !== undefined && page !== obj.page) {
      obj.page = page;
      coercions.push("page_to_int");
    }
  }
  return coercions;
}

function coerceCreateGithubPullRequest(
  obj: Record<string, unknown>,
): string[] {
  const coercions: string[] = [];
  applyUnwrap(obj, coercions, ["owner", "repo", "title", "head", "base", "body"]);
  coercions.push(
    ...aliasKeys(obj, [
      ["branch", "head"],
      ["base_branch", "base"],
      ["description", "body"],
    ]),
  );
  for (const key of [
    "owner",
    "repo",
    "title",
    "head",
    "base",
    "body",
  ] as const) {
    if (typeof obj[key] === "string") {
      const trimmed = trimString(obj[key] as string);
      if (trimmed.trimmed) {
        obj[key] = trimmed.text;
        coercions.push("trim");
      }
    }
  }
  return coercions;
}

function coerceAppendSetupMemory(obj: Record<string, unknown>): string[] {
  const coercions: string[] = [];
  applyUnwrap(obj, coercions, ["markdown"]);
  coercions.push(
    ...aliasKeys(obj, [
      ["text", "markdown"],
      ["content", "markdown"],
      ["memory", "markdown"],
    ]),
  );
  improveStringField(obj, "markdown", coercions);
  return coercions;
}

function coerceSaveSetupProfile(obj: Record<string, unknown>): string[] {
  const coercions: string[] = [];
  applyUnwrap(obj, coercions, ["environment", "memoryMarkdown"]);
  coercions.push(...aliasKeys(obj, [["memory_markdown", "memoryMarkdown"]]));
  if (
    obj.environment !== null &&
    typeof obj.environment === "object" &&
    !Array.isArray(obj.environment)
  ) {
    const env = { ...(obj.environment as Record<string, unknown>) };
    const envLabels = aliasKeys(env, [
      ["required_env", "requiredEnv"],
      ["required_services", "requiredServices"],
    ]);
    // Always write back: prefer-canonical strip deletes aliases without labels.
    obj.environment = env;
    if (envLabels.length > 0) {
      coercions.push(...envLabels);
    }
  }
  return coercions;
}

export function coerceToolArgs(
  toolName: string,
  raw: unknown,
): CoerceResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: {}, coercions: [] };
  }

  const value = { ...(raw as Record<string, unknown>) };
  let coercions: string[];

  switch (toolName) {
    case "post_thread_message":
      coercions = coercePostThreadMessage(value);
      break;
    case "post_thread_report":
      coercions = coercePostThreadReport(value);
      break;
    case "skill":
      coercions = coerceSkill(value);
      break;
    case "repo_map":
      coercions = coerceRepoMap(value);
      break;
    case "create_github_pull_request":
      coercions = coerceCreateGithubPullRequest(value);
      break;
    case "append_threadcord_setup_memory":
      coercions = coerceAppendSetupMemory(value);
      break;
    case "save_threadcord_setup_profile":
      coercions = coerceSaveSetupProfile(value);
      break;
    default:
      return { value, coercions: [] };
  }

  return { value, coercions };
}
