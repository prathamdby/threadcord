/**
 * Canonical API-key env var names for Pi built-in providers.
 * Mirrors `@mariozechner/pi-ai` `env-api-keys.ts` `getApiKeyEnvVars` (first entry wins).
 *
 * Used when injecting host secrets into the guest session env and when writing
 * `apiKey` fields in `models.json`. Prefer `_API_KEY` names over OAuth tokens.
 */
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
