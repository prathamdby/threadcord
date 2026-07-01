import { apiKeyEnvVarForProvider } from "./env-var-names.js";
import { isBuiltInPiProvider } from "./registry.js";
import type {
  PiModelsJson,
  PiModelsJsonProviderEntry,
  PiProviderDefinition,
  ProviderRegistry,
} from "./types.js";

function providerNeedsModelsJsonEntry(provider: PiProviderDefinition): boolean {
  if (!isBuiltInPiProvider(provider.id)) {
    return true;
  }
  const transport = provider.transport;
  if (!transport) {
    return false;
  }
  return Boolean(transport.baseUrl || transport.headers || transport.api);
}

function buildProviderEntry(
  provider: PiProviderDefinition,
): PiModelsJsonProviderEntry {
  const entry: PiModelsJsonProviderEntry = {};
  const transport = provider.transport;

  if (transport?.baseUrl) {
    entry.baseUrl = transport.baseUrl;
  }
  if (transport?.api) {
    entry.api = transport.api;
  }
  if (transport?.headers) {
    entry.headers = transport.headers;
  }

  if (!isBuiltInPiProvider(provider.id)) {
    entry.apiKey = apiKeyEnvVarForProvider(provider.id);
    entry.models = provider.models.map((id) => ({ id }));
  }

  return entry;
}

export function buildModelsJson(registry: ProviderRegistry): PiModelsJson | null {
  const providers: Record<string, PiModelsJsonProviderEntry> = {};

  for (const provider of registry.providers) {
    if (!providerNeedsModelsJsonEntry(provider)) {
      continue;
    }
    providers[provider.id] = buildProviderEntry(provider);
  }

  if (Object.keys(providers).length === 0) {
    return null;
  }

  return { providers };
}

export function providerNeedsModelsJson(
  registry: ProviderRegistry,
  providerId: string,
): boolean {
  const provider = registry.providers.find((entry) => entry.id === providerId);
  if (!provider) {
    return false;
  }
  return providerNeedsModelsJsonEntry(provider);
}
