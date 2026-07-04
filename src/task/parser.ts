import type { ParsedTaskRequest, TaskRequest } from "../types.js";

const REQUIRED_KEYS = ["repo", "branch"] as const;
const OPTIONAL_KEYS = ["push", "model"] as const;
const METADATA_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
type RequiredKey = (typeof REQUIRED_KEYS)[number];

export type ParseResult =
  { ok: true; request: ParsedTaskRequest } | { ok: false; message: string };

export interface ParseTaskMessageOptions {
  /** Allow an empty instruction when the Discord message includes attachments. */
  hasAttachments?: boolean | undefined;
}

/** Parses control-channel task messages: prose instruction, then trailing keyed metadata (repo, branch, optional model and push). */
export function parseTaskMessage(
  content: string,
  options: ParseTaskMessageOptions = {},
): ParseResult {
  const lines = content.split(/\r?\n/);
  const fields = new Map<string, string>();
  let metadataStart = lines.length;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      if (fields.size > 0) break;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/.exec(line);
    if (!match) break;
    const [, rawKey, rawValue] = match;
    if (!rawKey || !rawValue) break;
    const key = rawKey.toLowerCase();
    if (!METADATA_KEYS.has(key)) break;
    fields.set(key, rawValue.trim());
    metadataStart = index;
  }

  const instruction = lines.slice(0, metadataStart).join("\n").trim();
  if (!instruction && !options.hasAttachments) {
    return {
      ok: false,
      message: "Missing task instruction before the keyed fields.",
    };
  }

  const missing = REQUIRED_KEYS.filter((key) => !fields.get(key));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    };
  }

  const request: ParsedTaskRequest = {
    instruction,
    repo: requiredField(fields, "repo"),
    branch: requiredField(fields, "branch"),
  };
  const model = fields.get("model");
  if (model) request.model = model;
  const pushOverride = fields.get("push");
  if (pushOverride) request.pushOverride = pushOverride;
  return { ok: true, request };
}

function requiredField(fields: Map<string, string>, key: RequiredKey): string {
  const value = fields.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
