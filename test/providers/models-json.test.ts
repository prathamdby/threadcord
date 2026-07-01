import { describe, expect, it } from "vitest";
import {
  loadModelsJsonSourceSync,
  validateModelsJsonShape,
} from "../../src/providers/index.js";

describe("loadModelsJsonSourceSync", () => {
  it("parses inline JSON", () => {
    const models = loadModelsJsonSourceSync(
      JSON.stringify({
        providers: { anthropic: { baseUrl: "https://proxy/v1" } },
      }),
    );

    expect(models.providers.anthropic?.baseUrl).toBe("https://proxy/v1");
  });

  it("rejects invalid inline JSON", () => {
    expect(() => loadModelsJsonSourceSync("{")).toThrow(/not valid JSON/);
  });
});

describe("validateModelsJsonShape", () => {
  it("requires a providers object", () => {
    expect(() => validateModelsJsonShape({})).toThrow(/providers object/);
  });
});
