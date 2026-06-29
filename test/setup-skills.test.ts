import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import {
  buildSkillsInstallShellCommand,
  discoverInstalledSkills,
  parseSkillLink,
  parseSkillLinksInput,
  validateSkillLinkLines,
} from "../src/setup/skills.js";

describe("setup skills", () => {
  it("parses repo URL as install all skills", () => {
    expect(parseSkillLink("https://github.com/prathamdby/skills")).toEqual({
      packageArg: "https://github.com/prathamdby/skills",
      skillFlag: undefined,
    });
  });

  it("parses tree URL to single skill", () => {
    expect(
      parseSkillLink(
        "https://github.com/prathamdby/skills/tree/main/skills/commit",
      ),
    ).toEqual({
      packageArg: "prathamdby/skills",
      skillFlag: "commit",
    });
  });

  it("builds global skills add command", () => {
    const cmd = buildSkillsInstallShellCommand([
      "https://github.com/prathamdby/skills/tree/main/skills/commit",
    ]);
    expect(cmd).toContain("npx");
    expect(cmd).toContain("skills@latest");
    expect(cmd).toContain("add");
    expect(cmd).toContain("prathamdby/skills");
    expect(cmd).toContain("-g");
    expect(cmd).toContain("commit");
  });

  it("splits multiline skill input", () => {
    expect(parseSkillLinksInput("a\n\nb\n")).toEqual(["a", "b"]);
  });

  it("rejects unrecognized skill links", () => {
    expect(validateSkillLinkLines(["not a url at all"])).toMatchObject({
      ok: false,
    });
  });
});

describe("discoverInstalledSkills", () => {
  const testHome = join(tmpdir(), `threadcord-skill-test-${Date.now()}`);

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("returns empty array when no skill dirs exist", () => {
    expect(discoverInstalledSkills(testHome)).toEqual([]);
  });

  it("discovers skills from .agents/skills", () => {
    const skillsDir = join(testHome, ".agents", "skills");
    mkdirSync(join(skillsDir, "commit"), { recursive: true });
    mkdirSync(join(skillsDir, "prath-mode"), { recursive: true });
    expect(discoverInstalledSkills(testHome)).toEqual([
      "commit",
      "prath-mode",
    ]);
  });

  it("deduplicates skills across multiple directories", () => {
    mkdirSync(join(testHome, ".agents", "skills", "commit"), {
      recursive: true,
    });
    mkdirSync(join(testHome, ".pi", "agent", "skills", "commit"), {
      recursive: true,
    });
    mkdirSync(join(testHome, ".pi", "agent", "skills", "peer-review"), {
      recursive: true,
    });
    const skills = discoverInstalledSkills(testHome);
    expect(skills).toEqual(["commit", "peer-review"]);
  });

  it("returns sorted skill names", () => {
    const skillsDir = join(testHome, ".agents", "skills");
    mkdirSync(join(skillsDir, "z-skill"), { recursive: true });
    mkdirSync(join(skillsDir, "a-skill"), { recursive: true });
    mkdirSync(join(skillsDir, "m-skill"), { recursive: true });
    expect(discoverInstalledSkills(testHome)).toEqual([
      "a-skill",
      "m-skill",
      "z-skill",
    ]);
  });
});
