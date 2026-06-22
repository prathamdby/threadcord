import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const baseEnv = {
  DATABASE_URL: "postgres://example",
  DISCORD_BOT_TOKEN: "discord",
  DISCORD_CHANNEL_ID: "channel",
  GITHUB_TOKEN: "github",
  ALLOWED_REPOS: "owner/*",
  ALLOWED_MODELS: "anthropic/claude-sonnet-4-5",
  ANTHROPIC_API_KEY: "anthropic",
};

describe("loadConfig", () => {
  it("treats empty THREADCORD_HTTP_BEARER as unset outside production", () => {
    const config = loadConfig({
      ...baseEnv,
      THREADCORD_HTTP_BEARER: "",
    });

    expect(config.THREADCORD_HTTP_BEARER).toBeUndefined();
  });

  it("requires THREADCORD_HTTP_BEARER when NODE_ENV is production", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
        THREADCORD_HTTP_BEARER: "",
      }),
    ).toThrow(/THREADCORD_HTTP_BEARER/);
  });

  it("accepts THREADCORD_HTTP_BEARER in production", () => {
    const config = loadConfig({
      ...baseEnv,
      NODE_ENV: "production",
      THREADCORD_HTTP_BEARER: "secret",
    });

    expect(config.THREADCORD_HTTP_BEARER).toBe("secret");
  });
});
