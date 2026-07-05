import {
  type Dirent,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { discoverSkills, findSkill } from "./discover.js";

/**
 * Max total bytes returned from a single `read` action. Skills are meant to be
 * small instruction sets; the cap keeps an oversized package from blowing the
 * context window while still enforcing a complete read of typical skills.
 */
const READ_TOTAL_MAX_BYTES = 120_000;

/** Skills per page for action "list" (keeps large catalogs readable). */
export const LIST_PAGE_SIZE = 25;

const MISS_ERROR_NAME_SAMPLE = 12;

const SKILL_DESCRIPTION = `Discover and load installed agent skills (workflow playbooks like /prath-mode, commit, peer-review, tdd, etc.).

Use this instead of hunting for SKILL.md files with read/glob. It does two things:

- action "list": returns installed skills (global under HOME, project under the checkout) with name, scope, and one-line summary. Results are paginated (${LIST_PAGE_SIZE} per page); the output states page number and total. Optional \`page\` (integer, 1-based) selects a page; omit \`page\` for page 1.
- action "read": pass \`name\` (bare skill id, e.g. \`prath-mode\` — not \`/prath-mode\`) to load that skill. Returns the FULL contents of every file in the skill directory in one call. When the user says "/prath-mode" or "use commit", call read with \`name\` \`prath-mode\` or \`commit\`, then follow the loaded workflow.

Skills are already installed; do not reinstall them. Skill instructions about git hooks, commit messages, or branch names are overridden by the GIT WORKFLOW rules in your system prompt.`;

const SkillAction = v.picklist(["list", "read"], "action must be 'list' or 'read'");

export function createSkillTools(homeDir: string, projectDir: string) {
  return [
    defineTool({
      name: "skill",
      description: SKILL_DESCRIPTION,
      parameters: v.object({
        action: SkillAction,
        name: v.optional(v.pipe(v.string(), v.minLength(1))),
        page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      }),
      async execute(input) {
        if (input.action === "list") {
          return formatSkillList(homeDir, projectDir, input.page ?? 1);
        }
        if (!input.name) {
          throw new Error(
            "skill 'read' requires a `name`. Call action 'list' first to see available skills.",
          );
        }
        const skill = findSkill(input.name, homeDir, projectDir);
        if (!skill) {
          const available = discoverSkills(homeDir, projectDir);
          throw new Error(
            formatSkillMissMessage(input.name, available.map((s) => s.name)),
          );
        }
        return formatSkillContents(skill);
      },
    }),
  ];
}

export { SKILL_DESCRIPTION };

function formatSkillList(
  homeDir: string,
  projectDir: string,
  page: number,
): string {
  const skills = discoverSkills(homeDir, projectDir);
  if (skills.length === 0) {
    return "No skills installed. Global skills live under ~/.agents/skills/ (HOME) and project skills under .agents/skills/ in the checkout.";
  }
  const totalPages = Math.max(1, Math.ceil(skills.length / LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * LIST_PAGE_SIZE;
  const pageSkills = skills.slice(start, start + LIST_PAGE_SIZE);
  const lines = pageSkills.map((skill) => {
    const summary = skill.summary ? ` — ${skill.summary}` : "";
    return `- ${skill.name} [${skill.scope}]${summary}`;
  });
  const footer: string[] = [
    "",
    'Call skill with action "read" and a bare `name` (no leading slash) to load a skill\'s full workflow.',
  ];
  if (totalPages > 1) {
    footer.push(
      "",
      `Pagination: showing page ${safePage} of ${totalPages} (${LIST_PAGE_SIZE} skills per page, ${skills.length} total).`,
      safePage < totalPages
        ? `More skills on later pages — call skill with action "list" and page ${safePage + 1}.`
        : "",
    );
  }
  return [
    `Available skills — page ${safePage} of ${totalPages} (${skills.length} total):`,
    ...lines,
    ...footer.filter(Boolean),
  ].join("\n");
}

function formatSkillMissMessage(
  requestedName: string,
  availableNames: string[],
): string {
  const sample = availableNames.slice(0, MISS_ERROR_NAME_SAMPLE);
  const extra = availableNames.length - sample.length;
  const list =
    sample.length === 0
      ? "(none)"
      : `${sample.join(", ")}${extra > 0 ? ` (+${extra} more; use action "list" with page)` : ""}`;
  return `No skill named "${requestedName}". Use bare ids (e.g. prath-mode, not /prath-mode). Sample installed: ${list}.`;
}

function formatSkillContents(skill: {
  name: string;
  scope: string;
  path: string;
}): string {
  const files = collectFiles(skill.path);
  if (files.length === 0) {
    return `Skill "${skill.name}" (${skill.scope}) at ${skill.path} contains no readable files.`;
  }

  const parts: string[] = [
    `# Skill: ${skill.name} (${skill.scope})`,
    `# Source: ${skill.path}`,
    "",
    "Loaded the FULL contents of every file below. Follow this skill's workflow.",
    "",
  ];

  let used = 0;
  let truncated = 0;
  for (const file of files) {
    const relPath = relative(skill.path, file.path) || file.path;
    const header = `--- ${relPath} ---`;
    const remaining = READ_TOTAL_MAX_BYTES - used - header.length - 6;
    if (remaining <= 0) {
      truncated++;
      continue;
    }
    const content = file.content.slice(0, remaining);
    parts.push(header, content);
    used += header.length + content.length + 6;
    if (content.length < file.content.length) {
      truncated += 1;
    }
  }

  if (truncated > 0) {
    parts.push(
      "",
      `(...${truncated} file(s)/portion(s) omitted to stay under the ${READ_TOTAL_MAX_BYTES}-byte read cap; the skill's primary instructions are above.)`,
    );
  }

  return parts.join("\n");
}

interface SkillFile {
  path: string;
  content: string;
}

/** Collects every readable text file under a skill directory, sorted by path. */
function collectFiles(skillDir: string): SkillFile[] {
  let realSkillDir: string;
  try {
    realSkillDir = realpathSync(skillDir);
  } catch {
    return [];
  }

  const results: SkillFile[] = [];
  // Real paths already recursed into — prevents circular symlinks from
  // blowing the stack.
  const visited = new Set<string>([realSkillDir]);

  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      let stat: ReturnType<typeof statSync>;
      try {
        // statSync follows symlinks, so isDirectory() is true for symlinked
        // directories and isSymbolicLink() is never true — see below.
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // Skip VCS and dependency dirs inside skills, just in case.
        if (entry.name === ".git" || entry.name === "node_modules") continue;

        // Resolve the real target and refuse to leave the skill directory or
        // re-enter a visited dir (handles circular symlinks and traversal).
        let realPath: string;
        try {
          realPath = realpathSync(fullPath);
        } catch {
          continue;
        }
        if (visited.has(realPath) || !isWithinSkill(realSkillDir, realPath)) {
          continue;
        }
        visited.add(realPath);
        walk(fullPath);
        continue;
      }
      if (!stat.isFile()) continue;
      // Skip symlinked files whose real target escapes the skill directory.
      let realFile: string;
      try {
        realFile = realpathSync(fullPath);
      } catch {
        continue;
      }
      if (!isWithinSkill(realSkillDir, realFile)) continue;
      try {
        const content = readFileSync(fullPath, "utf8");
        results.push({ path: fullPath, content });
      } catch {
        // Skip unreadable (binary/permission) files.
      }
    }
  };
  walk(skillDir);
  // Stable, human-readable ordering: SKILL.md first, then alphabetical.
  results.sort((a, b) => {
    const ar = relative(skillDir, a.path);
    const br = relative(skillDir, b.path);
    if (ar === "SKILL.md") return -1;
    if (br === "SKILL.md") return 1;
    return ar.localeCompare(br);
  });
  return results;
}

/** True when `target` is `ancestor` itself or lives strictly beneath it. */
function isWithinSkill(ancestor: string, target: string): boolean {
  const rel = relative(ancestor, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}