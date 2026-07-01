import {
  assertProviderAuthConfigured,
  deriveAllowedModels,
  discoverConfiguredProviderIds,
} from "./discovery.js";
import { validateAllowedModelRef } from "./admission.js";
import {
  loadModelsJsonSourceAsync,
  loadModelsJsonSourceSync,
  optionalEnv,
  validateModelsJsonShape,
} from "./models-json.js";
import type { LoadPiConfigInput, PiHostConfig } from "./types.js";

function buildPiHostConfig(
  input: LoadPiConfigInput,
  modelsJson: PiHostConfig["modelsJson"],
): PiHostConfig {
  const env = input.env ?? process.env;

  if (discoverConfiguredProviderIds(env, modelsJson).length === 0) {
    throw new Error(
      "At least one Pi provider must be configured (set an API key env var or PI_MODELS_JSON)",
    );
  }

  const allowedModels = deriveAllowedModels(env, modelsJson);
  if (allowedModels.length === 0) {
    throw new Error("No models available from configured Pi providers");
  }

  const defaultModel = optionalEnv(input.defaultModel) ?? allowedModels[0]!;

  if (!allowedModels.includes(defaultModel)) {
    throw new Error(
      `DEFAULT_MODEL "${defaultModel}" is not available from configured providers`,
    );
  }

  for (const providerId of discoverConfiguredProviderIds(env, modelsJson)) {
    assertProviderAuthConfigured(providerId, env, modelsJson);
  }

  return {
    allowedModels,
    defaultModel,
    ...(modelsJson !== undefined ? { modelsJson } : {}),
  };
}

export function loadPiConfig(input: LoadPiConfigInput): PiHostConfig {
  const modelsJsonRaw = optionalEnv(input.modelsJsonRaw);
  const modelsJson = modelsJsonRaw
    ? loadModelsJsonSourceSync(modelsJsonRaw)
    : undefined;
  return buildPiHostConfig(input, modelsJson);
}

export async function loadPiConfigAsync(
  input: LoadPiConfigInput,
): Promise<PiHostConfig> {
  const modelsJsonRaw = optionalEnv(input.modelsJsonRaw);
  const modelsJson = modelsJsonRaw
    ? await loadModelsJsonSourceAsync(modelsJsonRaw)
    : undefined;
  return buildPiHostConfig(input, modelsJson);
}

export function loadPiConfigFromParsed(input: {
  defaultModel?: string;
  modelsJson?: unknown;
  env?: NodeJS.ProcessEnv;
}): PiHostConfig {
  const modelsJson =
    input.modelsJson === undefined
      ? undefined
      : validateModelsJsonShape(input.modelsJson);
  return buildPiHostConfig(input, modelsJson);
}

export { validateAllowedModelRef };
