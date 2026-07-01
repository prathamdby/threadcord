import type { PiApiType, PiProviderTransport } from "./types.js";

const SUPPORTED_APIS: PiApiType[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

export function providerEnvPrefix(id: string): string {
  return `PROVIDER_${id.replace(/-/g, "_").toUpperCase()}`;
}

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

function requiredEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  providerId: string,
): string {
  const value = optionalEnv(env[key]);
  if (!value) {
    throw new Error(`${key} is required for provider "${providerId}"`);
  }
  return value;
}

export function parseHeadersEnv(
  value: string | undefined,
  key: string,
): Record<string, string> | undefined {
  const trimmed = optionalEnv(value);
  if (!trimmed) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${key} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object of string header values`);
  }

  const headers: Record<string, string> = Object.create(null);
  for (const [headerName, headerValue] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof headerValue !== "string") {
      throw new Error(`${key} must be a JSON object of string header values`);
    }
    headers[headerName] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export interface ParsedProviderBlock {
  id: string;
  models: string[];
  apiKey?: string;
  transport: PiProviderTransport;
}

export function parseProviderBlock(
  env: NodeJS.ProcessEnv,
  id: string,
  builtIn: boolean,
): ParsedProviderBlock {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`Invalid provider id "${id}"`);
  }

  const prefix = providerEnvPrefix(id);
  const baseUrl = optionalEnv(env[`${prefix}_BASE_URL`]);
  const apiRaw = optionalEnv(env[`${prefix}_API`]);
  const models = splitCsv(optionalEnv(env[`${prefix}_MODELS`]));
  const apiKey = optionalEnv(env[`${prefix}_API_KEY`]);
  const headers = parseHeadersEnv(env[`${prefix}_HEADERS`], `${prefix}_HEADERS`);

  if (apiRaw && !SUPPORTED_APIS.includes(apiRaw as PiApiType)) {
    throw new Error(
      `${prefix}_API must be one of ${SUPPORTED_APIS.join(", ")} for Pi agent software; got "${apiRaw}"`,
    );
  }

  if (!builtIn) {
    if (!baseUrl) {
      throw new Error(`${prefix}_BASE_URL is required for provider "${id}"`);
    }
    if (!apiRaw) {
      throw new Error(`${prefix}_API is required for provider "${id}"`);
    }
    if (models.length === 0) {
      throw new Error(`${prefix}_MODELS must not be empty`);
    }
  }

  const transport: PiProviderTransport = {
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiRaw ? { api: apiRaw as PiApiType } : {}),
    ...(headers ? { headers } : {}),
  };

  return {
    id,
    models,
    ...(apiKey ? { apiKey } : {}),
    transport,
  };
}

export function parseCustomProviderIds(providersCsv?: string): string[] {
  return [...new Set(splitCsv(providersCsv))];
}
