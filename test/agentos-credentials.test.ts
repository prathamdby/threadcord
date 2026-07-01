import { describe, expect, it } from "vitest";
import {
  createAgentOsCredentialsProvider,
  guestApiKeyEnvVarForProvider,
} from "../src/agentturn/agentos.js";
import type { AppConfig } from "../src/config.js";

const baseConfig = {
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  customProviders: [
    {
      id: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      api: "openai-completions",
      apiKey: "opencode-secret",
      models: ["deepseek-v4-flash"],
    },
    {
      id: "my-gateway",
      baseUrl: "https://gateway.example.com/v1",
      api: "openai-completions",
      apiKey: "gateway-secret",
      models: ["gpt-5-codex"],
    },
  ],
} as Pick<AppConfig, "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "customProviders">;

describe("guestApiKeyEnvVarForProvider", () => {
  it("maps opencode-go to OPENCODE_API_KEY for Pi guest sessions", () => {
    expect(guestApiKeyEnvVarForProvider("opencode-go")).toBe("OPENCODE_API_KEY");
  });

  it("normalizes hyphens to underscores for unknown custom providers", () => {
    expect(guestApiKeyEnvVarForProvider("my-gateway")).toBe("MY_GATEWAY_API_KEY");
  });
});

describe("createAgentOsCredentialsProvider", () => {
  it("forwards opencode-go credentials under OPENCODE_API_KEY", () => {
    const getCredentials = createAgentOsCredentialsProvider(
      baseConfig as AppConfig,
    );

    expect(getCredentials("opencode-go/deepseek-v4-flash")).toEqual({
      OPENCODE_API_KEY: "opencode-secret",
    });
  });

  it("forwards hyphenated custom provider credentials with normalized env names", () => {
    const getCredentials = createAgentOsCredentialsProvider(
      baseConfig as AppConfig,
    );

    expect(getCredentials("my-gateway/gpt-5-codex")).toEqual({
      MY_GATEWAY_API_KEY: "gateway-secret",
    });
  });
});
