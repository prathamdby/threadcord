import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import type { PiModelsJson } from "./types.js";

export function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function optionalEnv(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function validateModelsJsonShape(value: unknown): PiModelsJson {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PI_MODELS_JSON must be an object with a providers field");
  }
  const providers = (value as Record<string, unknown>).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("PI_MODELS_JSON must include a providers object");
  }
  for (const [providerId, entry] of Object.entries(providers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `PI_MODELS_JSON providers.${providerId} must be an object`,
      );
    }
  }
  return value as PiModelsJson;
}

export function parseApiKeyEnvRef(apiKeyField: string): string {
  const trimmed = apiKeyField.trim();
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) {
    return trimmed.slice(2, -1).trim();
  }
  if (trimmed.startsWith("$")) {
    return trimmed.slice(1).trim();
  }
  return trimmed;
}

export function loadModelsJsonSourceSync(raw: string): PiModelsJson {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("PI_MODELS_JSON inline value is not valid JSON");
    }
    return validateModelsJsonShape(parsed);
  }

  let fileContents: string;
  try {
    fileContents = readFileSync(trimmed, "utf8");
  } catch {
    throw new Error(`PI_MODELS_JSON path not readable: ${trimmed}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents);
  } catch {
    throw new Error(`PI_MODELS_JSON file is not valid JSON: ${trimmed}`);
  }
  return validateModelsJsonShape(parsed);
}

export async function loadModelsJsonSourceAsync(
  raw: string,
): Promise<PiModelsJson> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return loadModelsJsonSourceSync(trimmed);
  }

  let fileContents: string;
  try {
    fileContents = await readFileAsync(trimmed, "utf8");
  } catch {
    throw new Error(`PI_MODELS_JSON path not readable: ${trimmed}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents);
  } catch {
    throw new Error(`PI_MODELS_JSON file is not valid JSON: ${trimmed}`);
  }
  return validateModelsJsonShape(parsed);
}

export function stableStringifyModelsJson(modelsJson: PiModelsJson): string {
  return `${JSON.stringify(modelsJson, null, 2)}\n`;
}
