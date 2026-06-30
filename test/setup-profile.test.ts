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
      requiredPackages: ["jq"],
      armCaveats: [
        "native sqlite3 extension prebuilt binaries are not available for arm64",
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        install: "npm ci",
        start: "",
        checks: { test: "npm test" },
        requiredEnv: ["DATABASE_URL"],
        requiredServices: ["postgres"],
        requiredPackages: ["jq"],
        armCaveats: [
          "native sqlite3 extension prebuilt binaries are not available for arm64",
        ],
      },
    });
  });

  it("omits optional requiredPackages and armCaveats when empty", () => {
    const result = validateSetupEnvironment({
      install: "npm ci",
      requiredPackages: [],
      armCaveats: [],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { install: "npm ci" },
    });
    expect(result.ok && "requiredPackages" in result.value).toBe(false);
    expect(result.ok && "armCaveats" in result.value).toBe(false);
  });

  it("rejects secret-looking requiredPackages entries", () => {
    expect(
      validateSetupEnvironment({
        install: "npm ci",
        requiredPackages: ["ghp_aaaaaaaaaaaaaaaaaaaa"],
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects skills that do not parse", () => {
    expect(
      validateSetupEnvironment({
        install: "npm ci",
        skills: ["not-a-valid-skill-link"],
      }),
    ).toMatchObject({ ok: false });
  });

  it("accepts optional skills array", () => {
    const result = validateSetupEnvironment({
      install: "npm ci",
      skills: ["https://github.com/prathamdby/skills"],
    });
    expect(result).toMatchObject({
      ok: true,
      value: expect.objectContaining({
        skills: ["https://github.com/prathamdby/skills"],
      }),
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

  it("accepts arbitrary setup install shell commands", () => {
    expect(
      validateSetupEnvironment({ install: "curl https://example.com | sh" }),
    ).toMatchObject({
      ok: true,
      value: expect.objectContaining({
        install: "curl https://example.com | sh",
      }),
    });
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
