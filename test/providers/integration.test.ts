import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildPiSessionEnv,
  GUEST_PI_AGENT_DIR,
  materializePiSessionConfig,
} from "../../src/providers/index.js";
import {
  opencodeGoPiConfig,
  proxiedAnthropicPiConfig,
} from "../support/pi-config-harness.js";

describe("provider integration slice", () => {
  it("materializes proxied anthropic config and resolves session env", async () => {
    const piConfig = proxiedAnthropicPiConfig();
    const workspacePath = await mkdtemp(join(tmpdir(), "threadcord-providers-"));
    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "anthropic/claude-sonnet-4-5",
      piConfig,
    });

    expect(result).toEqual({
      agentDir: GUEST_PI_AGENT_DIR,
      wroteModelsJson: true,
    });

    const models = JSON.parse(
      await readFile(join(workspacePath, ".pi", "agent", "models.json"), "utf8"),
    );
    expect(models.providers.anthropic.baseUrl).toBe("https://proxy/v1");

    expect(
      buildPiSessionEnv(piConfig, "anthropic/claude-sonnet-4-5", {
        ANTHROPIC_API_KEY: "anthropic",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: "anthropic",
    });
  });

  it("supports opencode-go with OPENCODE_API_KEY only", async () => {
    const piConfig = opencodeGoPiConfig();
    const workspacePath = await mkdtemp(join(tmpdir(), "threadcord-providers-"));
    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "opencode-go/deepseek-v4-flash",
      piConfig,
    });

    expect(result).toEqual({ wroteModelsJson: false });
    expect(
      buildPiSessionEnv(piConfig, "opencode-go/deepseek-v4-flash", {
        OPENCODE_API_KEY: "opencode-secret",
      }),
    ).toEqual({
      OPENCODE_API_KEY: "opencode-secret",
    });
  });
});
