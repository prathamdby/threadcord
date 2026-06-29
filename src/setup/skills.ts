import { readdirSync } from "node:fs";
import { join } from "node:path";

const SKILL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const SKILL_DIRS = [".agents/skills", ".pi/agent/skills", ".tabnine/agent/skills"];

/**
 * Discover skill names installed under the workspace HOME directory.
 * Skills are installed globally by `skills add -g` into directories like
 * `$HOME/.agents/skills/<skill-name>/`.
 */
export function discoverInstalledSkills(workspaceHome: string): string[] {
  const seen = new Set<string>();
  for (const rel of SKILL_DIRS) {
    try {
      const dir = join(workspaceHome, rel);
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          SKILL_NAME.test(entry.name)
        ) {
          seen.add(entry.name);
        }
      }
    } catch {
      // Directory may not exist; skip.
    }
  }
  return [...seen].sort();
}

const GITHUB_TREE_SKILL =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/i;
const GITHUB_REPO = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const GITHUB_BLOB =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i;

export interface ParsedSkillLink {
  packageArg: string;
  skillFlag?: string;
}

export function parseSkillLinksInput(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseSkillLink(line: string): ParsedSkillLink | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  const tree = GITHUB_TREE_SKILL.exec(trimmed);
  if (tree) {
    const owner = tree[1];
    const repo = tree[2];
    const pathAfterBranch = tree[4];
    if (!owner || !repo || !pathAfterBranch) {
      return { packageArg: trimmed };
    }
    const segments = pathAfterBranch.split("/").filter(Boolean);
    const skillsIdx = segments.indexOf("skills");
    if (skillsIdx >= 0 && segments.length > skillsIdx + 1) {
      const skillName = segments[skillsIdx + 1];
      if (skillName && SKILL_NAME.test(skillName)) {
        return {
          packageArg: `${owner}/${repo}`,
          skillFlag: skillName,
        };
      }
    }
    return { packageArg: trimmed };
  }

  const blob = GITHUB_BLOB.exec(trimmed);
  if (blob) {
    const owner = blob[1];
    const repo = blob[2];
    const pathAfterBranch = blob[4];
    if (!owner || !repo || !pathAfterBranch) {
      return { packageArg: trimmed };
    }
    const match = pathAfterBranch.match(/(?:^|\/)skills\/([a-z][a-z0-9-]*)\//);
    const skillFlag = match?.[1];
    if (skillFlag) {
      return {
        packageArg: `${owner}/${repo}`,
        skillFlag,
      };
    }
    return { packageArg: trimmed };
  }

  if (GITHUB_REPO.test(trimmed)) {
    return { packageArg: trimmed };
  }

  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return { packageArg: trimmed };
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { packageArg: trimmed };
  }

  return undefined;
}

export function buildSkillsAddArgv(parsed: ParsedSkillLink): string[] {
  const argv = [
    "npx",
    "-y",
    "skills@latest",
    "add",
    parsed.packageArg,
    "-g",
    "-y",
    "-a",
    "*",
  ];
  if (parsed.skillFlag) {
    argv.push("-s", parsed.skillFlag);
  } else {
    argv.push("--skill", "*");
  }
  return argv;
}

export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function validateSkillLinkLines(
  lines: string[],
): { ok: true; value: string[] } | { ok: false; message: string } {
  const trimmed = lines.map((line) => line.trim()).filter(Boolean);
  if (trimmed.length === 0) {
    return { ok: true, value: [] };
  }
  const invalid: string[] = [];
  for (const line of trimmed) {
    if (!parseSkillLink(line)) {
      invalid.push(line);
    }
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      message: `Unrecognized skill link(s): ${invalid.slice(0, 3).join(", ")}${
        invalid.length > 3 ? ` (+${invalid.length - 3} more)` : ""
      }`,
    };
  }
  return { ok: true, value: trimmed };
}

export function buildSkillsInstallShellCommand(links: string[]): string {
  const validated = validateSkillLinkLines(links);
  if (!validated.ok || validated.value.length === 0) {
    return "true";
  }
  const lines = validated.value
    .map((line) => parseSkillLink(line)!)
    .map((parsed) => buildSkillsAddArgv(parsed).map(shellQuote).join(" "));
  return lines.join(" && ");
}
