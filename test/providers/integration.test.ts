import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  GUEST_PI_AGENT_DIR,
  loadProviderRegistry,
  materializePiSessionConfig,
  resolvePiSessionCredentials,
} from "../../src/providers/index.js";

describe("provider integration slice", () => {
  it("materializes proxied anthropic config and resolves session credentials", async () => {
    const registry = loadProviderRegistry({
      anthropicApiKey: "anthropic-secret",
      anthropicModels: "claude-sonnet-4-5",
      providersCsv: "anthropic",
      env: {
        PROVIDER_ANTHROPIC_BASE_URL: "https://proxy/v1",
      },
    });

    const workspacePath = await mkdtemp(join(tmpdir(), "threadcord-providers-"));
    const result = await materializePiSessionConfig({
      workspacePath,
      repo: "acme/web",
      model: "anthropic/claude-sonnet-4-5",
      registry,
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
      resolvePiSessionCredentials(registry, "anthropic/claude-sonnet-4-5"),
    ).toEqual({
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
  });
});
