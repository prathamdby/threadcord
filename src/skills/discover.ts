import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SKILL_DIRS, SKILL_NAME } from "../setup/skills.js";

export type SkillScope = "global" | "project";

export interface DiscoveredSkill {
  /** Skill package name (directory name). */
  name: string;
  /** Where the skill lives: global (HOME) or project (checkout). */
  scope: SkillScope;
  /** Absolute path to the skill directory. */
  path: string;
  /** Short one-line summary pulled from the skill's SKILL.md, if present. */
  summary: string;
}

/** Max chars read from a SKILL.md when extracting a summary. */
const SUMMARY_SCAN_BYTES = 4096;
const SUMMARY_MAX_CHARS = 200;

/**
 * Extracts a short one-line summary from a SKILL.md file.
 *
 * Picks the first non-frontmatter, non-heading prose line (or the first
 * markdown heading line when no prose precedes it). Returns an empty string
 * when the SKILL.md is missing or unreadable.
 */
export function extractSkillSummary(skillMdPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(skillMdPath, "utf8").slice(0, SUMMARY_SCAN_BYTES);
  } catch {
    return "";
  }

  const lines = raw.split(/\r?\n/);
  let inFrontmatter = false;
  let checkedFirstLine = false;
  let firstHeading = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // YAML frontmatter is optional and may only appear at the very top.
    if (!checkedFirstLine) {
      checkedFirstLine = true;
      if (trimmed === "---") {
        inFrontmatter = true;
        continue;
      }
    }
    if (inFrontmatter) {
      if (trimmed === "---") {
        inFrontmatter = false;
      }
      continue;
    }

    // Prefer the first prose line; remember a heading as a fallback.
    if (trimmed.startsWith("#")) {
      if (!firstHeading) {
        firstHeading = trimmed.replace(/^#+\s*/, "").slice(0, SUMMARY_MAX_CHARS);
      }
      continue;
    }
    return trimmed.slice(0, SUMMARY_MAX_CHARS);
  }
  return firstHeading ?? "";
}

function isDirectoryOrSymlink(fullPath: string): boolean {
  try {
    const stat = statSync(fullPath);
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function scanScope(baseDir: string, scope: SkillScope): DiscoveredSkill[] {
  const found: DiscoveredSkill[] = [];
  for (const rel of SKILL_DIRS) {
    const skillsRoot = join(baseDir, rel);
    let entries: Dirent[];
    try {
      entries = readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        SKILL_NAME.test(entry.name)
      ) {
        const skillPath = join(skillsRoot, entry.name);
        if (!isDirectoryOrSymlink(skillPath)) continue;
        found.push({
          name: entry.name,
          scope,
          path: skillPath,
          summary: extractSkillSummary(join(skillPath, "SKILL.md")),
        });
      }
    }
  }
  return found;
}

/**
 * Discovers skills available to an agent turn.
 *
 * Global skills live under the per-task HOME directory (`homeDir`, e.g.
 * `<workspaceRoot>/.home/.agents/skills/...`); project skills live inside the
 * checked-out repo (`projectDir`, e.g. `<checkout>/.agents/skills/...`).
 * Returns skills de-duplicated by name, with global scope taking precedence
 * over project scope when a name exists in both.
 */
export function discoverSkills(
  homeDir: string,
  projectDir: string,
): DiscoveredSkill[] {
  const globalSkills = scanScope(homeDir, "global");
  const projectSkills = scanScope(projectDir, "project");

  const byName = new Map<string, DiscoveredSkill>();
  for (const skill of projectSkills) byName.set(skill.name, skill);
  for (const skill of globalSkills) byName.set(skill.name, skill);

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Finds a single skill by name, preferring the global copy over a project one. */
export function findSkill(
  name: string,
  homeDir: string,
  projectDir: string,
): DiscoveredSkill | undefined {
  return discoverSkills(homeDir, projectDir).find(
    (skill) => skill.name === name,
  );
}

/** Human-readable relative label for a skill path within its scope root. */
export function relativeSkillPath(skill: DiscoveredSkill): string {
  if (skill.scope === "global") return skill.path;
  try {
    return relative(join(), skill.path) || skill.path;
  } catch {
    return skill.path;
  }
}