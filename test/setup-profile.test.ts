import { describe, expect, it } from "vitest";
import {
  parseSetupProfileKey,
  validateSetupEnvironment,
  validateSetupMemory,
  validateSetupProfilePayload,
} from "../src/setup/profile.js";

describe("setup profile validation", () => {
  it("normalizes repository names and keeps branch names distinct", () => {
    expect(parseSetupProfileKey("Owner/Repo", "main")).toEqual({
      ok: true,
      value: { repo: "owner/repo", branch: "main" },
    });
    expect(parseSetupProfileKey("owner/repo", "release/v1")).toEqual({
      ok: true,
      value: { repo: "owner/repo", branch: "release/v1" },
    });
  });

  it("rejects invalid repository and branch names", () => {
    expect(parseSetupProfileKey("owner", "main")).toMatchObject({
      ok: false,
    });
    expect(parseSetupProfileKey("owner/repo", "../main")).toMatchObject({
      ok: false,
    });
  });

  it("accepts a valid environment JSON shape", () => {
    const result = validateSetupEnvironment({
      install: "npm ci",
      start: "",
      checks: { test: "npm test" },
      requiredEnv: ["DATABASE_URL"],
      requiredServices: ["postgres"],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        install: "npm ci",
        start: "",
        checks: { test: "npm test" },
        requiredEnv: ["DATABASE_URL"],
        requiredServices: ["postgres"],
      },
    });
  });

  it("rejects missing install commands and secret-looking env entries", () => {
    expect(validateSetupEnvironment({ install: "" })).toMatchObject({
      ok: false,
      message: "Environment install command is required.",
    });
    expect(
      validateSetupEnvironment({
        install: "npm ci",
        requiredEnv: ["DATABASE_URL=postgres://secret"],
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects memory that appears to contain credentials", () => {
    expect(validateSetupMemory("API_KEY=abc123")).toMatchObject({
      ok: false,
    });
  });

  it("validates environment and memory together", () => {
    expect(
      validateSetupProfilePayload({
        environment: {
          install: "npm ci",
          checks: { build: "npm run build" },
          requiredEnv: [],
          requiredServices: [],
        },
        memoryMarkdown: "Node app. Run npm ci first.",
      }),
    ).toMatchObject({ ok: true });
  });
});
