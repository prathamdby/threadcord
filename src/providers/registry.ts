import { getProviders } from "@mariozechner/pi-ai";
import {
  optionalEnv,
  parseCustomProviderIds,
  parseProviderBlock,
  splitCsv,
} from "./env.js";
import type { PiProviderDefinition, ProviderRegistry } from "./types.js";

export interface LoadProviderRegistryInput {
  anthropicApiKey?: string;
  anthropicModels?: string;
  openaiApiKey?: string;
  openaiModels?: string;
  providersCsv?: string;
  env?: NodeJS.ProcessEnv;
}

function isBuiltInPiProvider(providerId: string): boolean {
  return getProviders().includes(
    providerId as ReturnType<typeof getProviders>[number],
  );
}

function mergeProviderDefinitions(
  existing: PiProviderDefinition,
  incoming: PiProviderDefinition,
): PiProviderDefinition {
  const models =
    incoming.models.length > 0
      ? [...new Set(incoming.models)]
      : existing.models;

  const transport: PiProviderDefinition["transport"] = {
    ...existing.transport,
    ...incoming.transport,
  };
  const mergedHeaders = {
    ...existing.transport?.headers,
    ...incoming.transport?.headers,
  };
  if (Object.keys(mergedHeaders).length > 0) {
    transport.headers = mergedHeaders;
  }

  const hasTransport =
    transport &&
    (transport.baseUrl !== undefined ||
      transport.api !== undefined ||
      transport.headers !== undefined);

  const apiKey = incoming.apiKey ?? existing.apiKey;

  return {
    id: existing.id,
    models,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(hasTransport ? { transport } : {}),
  };
}

function addSugarProvider(
  byId: Map<string, PiProviderDefinition>,
  input: {
    id: string;
    apiKey?: string;
    models: string[];
  },
): void {
  if (input.models.length > 0 && !input.apiKey) {
    throw new Error(
      `${input.id === "anthropic" ? "ANTHROPIC" : "OPENAI"}_API_KEY is required when ${input.id === "anthropic" ? "ANTHROPIC" : "OPENAI"}_MODELS is set`,
    );
  }

  if (input.apiKey && input.models.length === 0) {
    throw new Error(
      `${input.id === "anthropic" ? "ANTHROPIC" : "OPENAI"}_MODELS is required when ${input.id === "anthropic" ? "ANTHROPIC" : "OPENAI"}_API_KEY is set`,
    );
  }

  if (!input.apiKey || input.models.length === 0) {
    return;
  }

  byId.set(input.id, {
    id: input.id,
    models: input.models,
    apiKey: input.apiKey,
  });
}

export function loadProviderRegistry(
  input: LoadProviderRegistryInput,
): ProviderRegistry {
  const env = input.env ?? process.env;
  const byId = new Map<string, PiProviderDefinition>();

  const anthropicApiKey = optionalEnv(input.anthropicApiKey);
  addSugarProvider(byId, {
    id: "anthropic",
    ...(anthropicApiKey !== undefined ? { apiKey: anthropicApiKey } : {}),
    models: splitCsv(input.anthropicModels),
  });

  const openaiApiKey = optionalEnv(input.openaiApiKey);
  addSugarProvider(byId, {
    id: "openai",
    ...(openaiApiKey !== undefined ? { apiKey: openaiApiKey } : {}),
    models: splitCsv(input.openaiModels),
  });

  for (const id of parseCustomProviderIds(input.providersCsv)) {
    const builtIn = isBuiltInPiProvider(id);
    const block = parseProviderBlock(env, id, builtIn);
    const provider: PiProviderDefinition = {
      id: block.id,
      models: block.models,
      ...(block.apiKey ? { apiKey: block.apiKey } : {}),
      ...(Object.keys(block.transport).length > 0
        ? { transport: block.transport }
        : {}),
    };

    const existing = byId.get(id);
    if (existing) {
      byId.set(id, mergeProviderDefinitions(existing, provider));
    } else if (provider.models.length > 0 || builtIn) {
      byId.set(id, provider);
    }
  }

  const providers = orderProviders([...byId.values()]);
  if (providers.length === 0) {
    throw new Error("At least one provider model must be configured");
  }

  for (const provider of providers) {
    if (provider.models.length === 0) {
      throw new Error(
        `provider "${provider.id}" has no models configured`,
      );
    }
  }

  return { providers };
}

function orderProviders(providers: PiProviderDefinition[]): PiProviderDefinition[] {
  const rank = (id: string): number => {
    if (id === "anthropic") return 0;
    if (id === "openai") return 1;
    return 2;
  };

  return [...providers].sort((a, b) => {
    const rankDiff = rank(a.id) - rank(b.id);
    if (rankDiff !== 0) return rankDiff;
    return a.id.localeCompare(b.id);
  });
}

export function deriveAllowedModels(registry: ProviderRegistry): string[] {
  const models: string[] = [];
  for (const provider of registry.providers) {
    for (const modelId of provider.models) {
      models.push(`${provider.id}/${modelId}`);
    }
  }
  return [...new Set(models)];
}

export function findProviderDefinition(
  registry: ProviderRegistry,
  providerId: string,
): PiProviderDefinition | undefined {
  return registry.providers.find((entry) => entry.id === providerId);
}

export { isBuiltInPiProvider };
