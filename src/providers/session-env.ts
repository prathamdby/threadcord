import type { PiHostConfig, PiModelsJson } from "./types.js";
import { parseApiKeyEnvRef } from "./models-json.js";
import { parseModelRef } from "./model-ref.js";

function piAiCanonicalEnvVarCandidates(providerId: string): string[] {
  if (providerId === "github-copilot") {
    return ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
  }
  if (providerId === "anthropic") {
    return ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"];
  }

  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    "azure-openai-responses": "AZURE_OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    google: "GEMINI_API_KEY",
    "google-vertex": "GOOGLE_CLOUD_API_KEY",
    groq: "GROQ_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    zai: "ZAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    moonshotai: "MOONSHOT_API_KEY",
    "moonshotai-cn": "MOONSHOT_API_KEY",
    huggingface: "HF_TOKEN",
    fireworks: "FIREWORKS_API_KEY",
    opencode: "OPENCODE_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
    "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
    "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
    xiaomi: "XIAOMI_API_KEY",
    "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  };

  const mapped = envMap[providerId];
  if (mapped) {
    return [mapped];
  }

  return [`${providerId.replace(/-/g, "_").toUpperCase()}_API_KEY`];
}

export function apiKeyEnvVarForProvider(providerId: string): string {
  const candidates = piAiCanonicalEnvVarCandidates(providerId);
  return candidates.find((key) => key.endsWith("_API_KEY")) ?? candidates[0]!;
}

function envVarNamesForProvider(
  providerId: string,
  modelsJson?: PiModelsJson,
): string[] {
  const names = new Set<string>();
  names.add(apiKeyEnvVarForProvider(providerId));

  const apiKeyField = modelsJson?.providers[providerId]?.apiKey;
  if (apiKeyField) {
    names.add(parseApiKeyEnvRef(apiKeyField));
  }

  return [...names];
}

export function buildPiSessionEnv(
  config: PiHostConfig,
  modelRef: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const { provider } = parseModelRef(modelRef);
  const sessionEnv: Record<string, string> = {};

  for (const envVarName of envVarNamesForProvider(provider, config.modelsJson)) {
    const value = optionalHostEnv(hostEnv[envVarName]);
    if (value !== undefined) {
      sessionEnv[envVarName] = value;
    }
  }

  return sessionEnv;
}

function optionalHostEnv(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
