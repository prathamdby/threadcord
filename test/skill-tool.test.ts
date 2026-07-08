import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillTools,
  LIST_PAGE_SIZE,
  SKILL_DESCRIPTION,
} from "../src/skills/skill-tool.js";
import {
  discoverSkills,
  extractSkillSummary,
  findSkill,
  normalizeSkillLookupName,
} from "../src/skills/discover.js";

function makeSkill(
  root: string,
  rel: string,
  name: string,
  files: Record<string, string>,
): void {
  const dir = join(root, rel, name);
  mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    mkdirSync(join(dir, fileName, ".."), { recursive: true });
    writeFileSync(join(dir, fileName), content);
  }
}

async function callSkill(
  homeDir: string,
  projectDir: string,
  args: { action: "list" | "read"; name?: string; page?: number },
): Promise<string> {
  const tools = createSkillTools(homeDir, projectDir);
  const tool = tools.find((t) => t.name === "skill")!;
  return tool.execute(args as never);
}

describe("createSkillTools", () => {
  it("registers a single tool named skill", () => {
    const tools = createSkillTools("/tmp/home", "/tmp/proj");
    expect(tools.map((t) => t.name)).toEqual(["skill"]);
    expect(SKILL_DESCRIPTION).toContain("list");
    expect(SKILL_DESCRIPTION).toContain("read");
    expect(SKILL_DESCRIPTION).toContain("FULL contents");
  });
});

describe("skill tool — list", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = join(tmpdir(), `threadcord-skill-home-${Date.now()}-${Math.random()}`);
    project = join(
      tmpdir(),
      `threadcord-skill-proj-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("reports no skills when none installed", async () => {
    const out = await callSkill(home, project, { action: "list" });
    expect(out).toContain("No skills installed");
  });

  it("lists global and project skills with scope and summary", async () => {
    makeSkill(home, ".agents/skills", "commit", {
      "SKILL.md": "# commit\n\nWalks through staging and committing.",
    });
    makeSkill(project, ".agents/skills", "tdd", {
      "SKILL.md":
        "---\ntitle: tdd\n---\n\n## TDD\n\nRed, green, refactor.",
    });
    const out = await callSkill(home, project, { action: "list" });
    expect(out).toContain("page 1 of 1 (2 total)");
    expect(out).toContain("- commit [global] — Walks through staging");
    expect(out).toContain("- tdd [project] — Red, green, refactor.");
  });

  it("dedupes names preferring global scope", async () => {
    makeSkill(home, ".agents/skills", "commit", {
      "SKILL.md": "# commit global",
    });
    makeSkill(project, ".agents/skills", "commit", {
      "SKILL.md": "# commit project",
    });
    const skills = discoverSkills(home, project);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.scope).toBe("global");
  });
});

describe("skill tool — read", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = join(tmpdir(), `threadcord-skill-home-${Date.now()}-${Math.random()}`);
    project = join(
      tmpdir(),
      `threadcord-skill-proj-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("requires a name for read", async () => {
    await expect(callSkill(home, project, { action: "read" })).rejects.toThrow(
      /skill validation failed/,
    );
    await expect(callSkill(home, project, { action: "read" })).rejects.toThrow(
      /name: Required/,
    );
  });

  it("errors with available names when the skill is missing", async () => {
    makeSkill(home, ".agents/skills", "commit", { "SKILL.md": "# commit" });
    await expect(
      callSkill(home, project, { action: "read", name: "nope" }),
    ).rejects.toThrow('No skill named "nope"');
  });

  it("returns the FULL contents of every file in the skill dir", async () => {
    makeSkill(home, ".agents/skills", "prath-mode", {
      "SKILL.md": "# prath-mode\n\nBe opinionated.",
      "rules.md": "1. Ship.\n2. No slop.",
      "nested/guide.md": "Deep guidance.",
    });
    const out = await callSkill(home, project, {
      action: "read",
      name: "prath-mode",
    });
    expect(out).toContain("Skill: prath-mode (global)");
    expect(out).toContain("--- SKILL.md ---");
    expect(out).toContain("Be opinionated.");
    expect(out).toContain("--- rules.md ---");
    expect(out).toContain("Ship.");
    expect(out).toContain("--- nested/guide.md ---");
    expect(out).toContain("Deep guidance.");
    expect(out).toContain("FULL contents");
  });

  it("SKILL.md is listed first among files", async () => {
    makeSkill(home, ".agents/skills", "aaa", {
      "zzz.md": "last",
      "SKILL.md": "first",
    });
    const out = await callSkill(home, project, { action: "read", name: "aaa" });
    const skillIdx = out.indexOf("--- SKILL.md ---");
    const zzzIdx = out.indexOf("--- zzz.md ---");
    expect(skillIdx).toBeGreaterThan(-1);
    expect(skillIdx).toBeLessThan(zzzIdx);
  });

  it("reads a project-scoped skill", async () => {
    makeSkill(project, ".agents/skills", "local-only", {
      "SKILL.md": "project skill body",
    });
    const out = await callSkill(home, project, {
      action: "read",
      name: "local-only",
    });
    expect(out).toContain("Skill: local-only (project)");
    expect(out).toContain("project skill body");
  });
});

describe("discoverSkills / findSkill / extractSkillSummary", () => {
  it("findSkill returns undefined for unknown names", () => {
    expect(findSkill("nope", "/nonexistent", "/nonexistent")).toBeUndefined();
  });

  it("extractSkillSummary handles missing files", () => {
    expect(extractSkillSummary("/nonexistent/SKILL.md")).toBe("");
  });

  it("extractSkillSummary skips frontmatter and prefers first prose line", () => {
    const dir = join(
      tmpdir(),
      `threadcord-skill-sum-${Date.now()}-${Math.random()}`,
    );
    const skillMd = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      skillMd,
      "---\ntitle: foo\ntags: [a]\n---\n\n# Foo\n\nDoes the thing well.\n",
    );
    expect(extractSkillSummary(skillMd)).toBe("Does the thing well.");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("skill tool — symlink safety", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = join(tmpdir(), `threadcord-skill-sym-${Date.now()}-${Math.random()}`);
    project = join(
      tmpdir(),
      `threadcord-skill-sym-proj-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("does not follow a symlink that escapes the skill directory", async () => {
    // An "outside" tree the skill must not read.
    const outside = join(
      tmpdir(),
      `threadcord-skill-out-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "HOST-SECRET");
    makeSkill(home, ".agents/skills", "evil", {
      "SKILL.md": "# evil\n\nLoads things.",
    });
    // Symlink inside the skill dir pointing outside.
    symlinkSync(outside, join(home, ".agents/skills", "evil", "escape-link"));
    const out = await callSkill(home, project, { action: "read", name: "evil" });
    expect(out).toContain("Loads things.");
    expect(out).not.toContain("HOST-SECRET");
    expect(out).not.toContain("escape-link");
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not infinite-loop on a circular symlink", async () => {
    makeSkill(home, ".agents/skills", "loopy", {
      "SKILL.md": "# loopy\n\nCircular.",
    });
    const skillDir = join(home, ".agents/skills", "loopy");
    // Self-referential symlink directory inside the skill.
    symlinkSync(skillDir, join(skillDir, "cycle"));
    // Should not throw (RangeError: Maximum call stack size exceeded).
    const out = await callSkill(home, project, { action: "read", name: "loopy" });
    expect(out).toContain("Circular.");
  });
});

describe("findSkill — name validation", () => {
  it("rejects traversal strings as skill names", () => {
    const home = join(tmpdir(), `threadcord-skill-trav-${Date.now()}-${Math.random()}`);
    const project = join(tmpdir(), `threadcord-skill-trav-p-${Date.now()}-${Math.random()}`);
    mkdirSync(join(home, ".agents", "skills", "real"), { recursive: true });
    expect(findSkill("../../etc", home, project)).toBeUndefined();
    expect(findSkill("..", home, project)).toBeUndefined();
    expect(findSkill("real/extra", home, project)).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("finds a skill directly without scanning all skills", () => {
    const home = join(tmpdir(), `threadcord-skill-direct-${Date.now()}-${Math.random()}`);
    mkdirSync(join(home, ".agents", "skills", "commit"), { recursive: true });
    writeFileSync(
      join(home, ".agents", "skills", "commit", "SKILL.md"),
      "# commit\n\nStage and commit.",
    );
    const skill = findSkill("commit", home, "/nonexistent");
    expect(skill?.name).toBe("commit");
    expect(skill?.scope).toBe("global");
    expect(skill?.summary).toBe("Stage and commit.");
    rmSync(home, { recursive: true, force: true });
  });

  it("normalizeSkillLookupName strips a leading slash", () => {
    expect(normalizeSkillLookupName("/prath-mode")).toBe("prath-mode");
    expect(normalizeSkillLookupName("commit")).toBe("commit");
  });

  it("findSkill resolves slash-prefixed user names", () => {
    const home = join(tmpdir(), `threadcord-skill-slash-${Date.now()}-${Math.random()}`);
    mkdirSync(join(home, ".agents", "skills", "prath-mode"), { recursive: true });
    writeFileSync(
      join(home, ".agents", "skills", "prath-mode", "SKILL.md"),
      "# prath-mode",
    );
    expect(findSkill("/prath-mode", home, "/nonexistent")?.name).toBe("prath-mode");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("skill tool — list pagination", () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = join(tmpdir(), `threadcord-skill-page-${Date.now()}-${Math.random()}`);
    project = join(
      tmpdir(),
      `threadcord-skill-page-p-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("paginates list output and hints for the next page", async () => {
    for (let i = 0; i < LIST_PAGE_SIZE + 3; i++) {
      const name = `skill-${String(i).padStart(2, "0")}`;
      makeSkill(home, ".agents/skills", name, { "SKILL.md": `# ${name}` });
    }
    const page1 = await callSkill(home, project, { action: "list", page: 1 });
    expect(page1).toContain(`page 1 of 2 (${LIST_PAGE_SIZE + 3} total)`);
    expect(page1).toContain(`page ${2}`);
    expect(page1).toContain("- skill-00");
    expect(page1).not.toContain("- skill-99");

    const page2 = await callSkill(home, project, { action: "list", page: 2 });
    expect(page2).toContain("page 2 of 2");
    expect(page2).toContain("- skill-25");
  });
});