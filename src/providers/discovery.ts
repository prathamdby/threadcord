import { getModels, getProviders } from "@mariozechner/pi-ai";
import { parseApiKeyEnvRef, optionalEnv } from "./models-json.js";
import type { PiHostConfig, PiModelsJson } from "./types.js";
import { apiKeyEnvVarForProvider } from "./session-env.js";

function isBuiltInPiProvider(providerId: string): boolean {
  return getProviders().includes(
    providerId as ReturnType<typeof getProviders>[number],
  );
}

function providerHasHostAuth(
  providerId: string,
  hostEnv: NodeJS.ProcessEnv,
  modelsJson?: PiModelsJson,
): boolean {
  const canonical = apiKeyEnvVarForProvider(providerId);
  if (optionalEnv(hostEnv[canonical])) {
    return true;
  }

  const apiKeyField = modelsJson?.providers[providerId]?.apiKey;
  if (!apiKeyField) {
    return false;
  }

  const envVarName = parseApiKeyEnvRef(apiKeyField);
  return optionalEnv(hostEnv[envVarName]) !== undefined;
}

export function discoverConfiguredProviderIds(
  hostEnv: NodeJS.ProcessEnv,
  modelsJson?: PiModelsJson,
): string[] {
  const providerIds = new Set<string>();

  for (const providerId of getProviders()) {
    if (providerHasHostAuth(providerId, hostEnv, modelsJson)) {
      providerIds.add(providerId);
    }
  }

  if (modelsJson) {
    for (const providerId of Object.keys(modelsJson.providers)) {
      if (isBuiltInPiProvider(providerId)) {
        if (providerHasHostAuth(providerId, hostEnv, modelsJson)) {
          providerIds.add(providerId);
        }
      } else if (modelsJson.providers[providerId]) {
        providerIds.add(providerId);
      }
    }
  }

  return orderProviderIds([...providerIds]);
}

function orderProviderIds(providerIds: string[]): string[] {
  const rank = (id: string): number => {
    if (id === "anthropic") return 0;
    if (id === "openai") return 1;
    return 2;
  };

  return [...providerIds].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.localeCompare(b);
  });
}

export function deriveAllowedModels(
  hostEnv: NodeJS.ProcessEnv,
  modelsJson?: PiModelsJson,
): string[] {
  const models: string[] = [];

  for (const providerId of discoverConfiguredProviderIds(hostEnv, modelsJson)) {
    if (isBuiltInPiProvider(providerId)) {
      for (const model of getModels(
        providerId as ReturnType<typeof getProviders>[number],
      )) {
        models.push(`${providerId}/${model.id}`);
      }
      continue;
    }

    const entry = modelsJson?.providers[providerId];
    if (!entry?.models?.length) {
      throw new Error(
        `PI_MODELS_JSON provider "${providerId}" must include a models list`,
      );
    }

    if (!providerHasHostAuth(providerId, hostEnv, modelsJson) && entry.apiKey) {
      throw new Error(
        `${parseApiKeyEnvRef(entry.apiKey)} is required for provider "${providerId}"`,
      );
    }

    for (const model of entry.models) {
      models.push(`${providerId}/${model.id}`);
    }
  }

  return [...new Set(models)];
}

export function assertProviderAuthConfigured(
  providerId: string,
  hostEnv: NodeJS.ProcessEnv,
  modelsJson?: PiHostConfig["modelsJson"],
): void {
  if (providerHasHostAuth(providerId, hostEnv, modelsJson)) {
    return;
  }

  const modelsEntry = modelsJson?.providers[providerId];
  if (modelsEntry?.apiKey) {
    throw new Error(
      `${parseApiKeyEnvRef(modelsEntry.apiKey)} is required for provider "${providerId}"`,
    );
  }

  if (isBuiltInPiProvider(providerId)) {
    throw new Error(
      `${apiKeyEnvVarForProvider(providerId)} is required for provider "${providerId}"`,
    );
  }

  if (modelsEntry) {
    return;
  }

  throw new Error(`Provider "${providerId}" is not configured`);
}
