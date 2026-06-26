const GITHUB_TREE_SKILL =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/i;
const GITHUB_REPO =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const GITHUB_BLOB =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i;

const SKILL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

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

export function buildSkillsInstallShellCommand(links: string[]): string {
  const lines = links
    .map((line) => parseSkillLink(line))
    .filter((parsed): parsed is ParsedSkillLink => parsed !== undefined)
    .map((parsed) => buildSkillsAddArgv(parsed).map(shellQuote).join(" "));
  if (lines.length === 0) {
    return "true";
  }
  return lines.join(" && ");
}