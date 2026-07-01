import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getProviders } from "@mariozechner/pi-ai";
import type { CustomProviderConfig } from "../config.js";
import { guestApiKeyEnvVarForProvider } from "./agentos.js";

export const PI_AGENT_DIR_NAME = ".pi-agent";
export const PI_PROJECT_DIR_NAME = ".pi";
export const GUEST_PI_AGENT_DIR = "/workspace/.pi-agent";

export interface MaterializePiAgentConfigInput {
  workspacePath: string;
  repo: string;
  model: string;
  customProviders: CustomProviderConfig[];
}

function parseModelRef(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`invalid model reference "${model}"`);
  }
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
  };
}

function providerConfigForModel(
  providerId: string,
  modelId: string,
  customProviders: CustomProviderConfig[],
): CustomProviderConfig | undefined {
  const provider = customProviders.find((entry) => entry.id === providerId);
  if (!provider) {
    return undefined;
  }
  if (!provider.models.includes(modelId)) {
    throw new Error(
      `model "${providerId}/${modelId}" is not configured in PROVIDER_${providerId.replace(/-/g, "_").toUpperCase()}_MODELS`,
    );
  }
  return provider;
}

function isBuiltInPiProvider(providerId: string): boolean {
  return getProviders().includes(
    providerId as ReturnType<typeof getProviders>[number],
  );
}

function checkoutPathForWorkspace(
  workspacePath: string,
  repo: string,
): string {
  return join(workspacePath, basename(repo));
}

export async function materializePiAgentConfig(
  input: MaterializePiAgentConfigInput,
): Promise<string | undefined> {
  const { provider, modelId } = parseModelRef(input.model);
  const checkoutPath = checkoutPathForWorkspace(
    input.workspacePath,
    input.repo,
  );
  const projectPiDir = join(checkoutPath, PI_PROJECT_DIR_NAME);
  await mkdir(projectPiDir, { recursive: true });

  await writeFile(
    join(projectPiDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: provider,
        defaultModel: modelId,
      },
      null,
      2,
    )}\n`,
  );

  const customProvider = providerConfigForModel(
    provider,
    modelId,
    input.customProviders,
  );
  if (!customProvider || isBuiltInPiProvider(customProvider.id)) {
    return undefined;
  }

  const agentDir = join(input.workspacePath, PI_AGENT_DIR_NAME);
  await mkdir(agentDir, { recursive: true });
  const apiKeyEnv = guestApiKeyEnvVarForProvider(customProvider.id);
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          [customProvider.id]: {
            baseUrl: customProvider.baseUrl,
            api: customProvider.api,
            apiKey: apiKeyEnv,
            ...(customProvider.headers
              ? { headers: customProvider.headers }
              : {}),
            models: [{ id: modelId }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  return GUEST_PI_AGENT_DIR;
}
