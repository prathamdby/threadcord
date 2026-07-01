import { apiKeyEnvVarForProvider } from "./env-var-names.js";
import { findProviderDefinition } from "./registry.js";
import type { ProviderRegistry } from "./types.js";

export function parseModelRef(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`invalid model reference "${model}"`);
  }
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
  };
}

export function resolvePiSessionCredentials(
  registry: ProviderRegistry,
  modelRef: string,
): Record<string, string> {
  const { provider: providerId } = parseModelRef(modelRef);
  const provider = findProviderDefinition(registry, providerId);
  if (!provider?.apiKey) {
    return {};
  }

  return {
    [apiKeyEnvVarForProvider(providerId)]: provider.apiKey,
  };
}

export function createPiSessionCredentialsResolver(
  registry: ProviderRegistry,
): (model: string) => Record<string, string> {
  return (model) => resolvePiSessionCredentials(registry, model);
}
