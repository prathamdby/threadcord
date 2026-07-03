import { ModalBuilder } from "discord.js";
import { buildCustomId, modalRow } from "../discord/ui/index.js";
import type { SetupEnvironment } from "./profile.js";
import { parseSkillLinksInput } from "./skills.js";

export interface PendingSetupWizard {
  repo: string;
  branch: string;
  model?: string;
  skills: string[];
  update: boolean;
  install: string;
  start: string;
  checks: Record<string, string>;
  createdAt: number;
}

export function setupCreateRunModal(
  userId: string,
  mode: "create" | "update",
  existing?: SetupEnvironment,
  repoDefault?: string,
  branchDefault?: string,
): ModalBuilder {
  const checksDefault =
    existing && Object.keys(existing.checks).length > 0
      ? Object.entries(existing.checks)
          .map(([name, command]) => `${name}=${command}`)
          .join("\n")
      : "test=npm test\nbuild=npm run build\ntypecheck=npm run check";
  const skillsDefault = (existing?.skills ?? []).join("\n");
  return new ModalBuilder()
    .setCustomId(buildCustomId("setup", "create-run", mode, userId))
    .setTitle(mode === "create" ? "Setup create" : "Setup update")
    .addComponents(
      modalRow("repo", "Repository (owner/repo)", {
        value: repoDefault ?? "",
        required: true,
        style: "short",
        maxLength: 100,
      }),
      modalRow("branch", "Base branch", {
        value: branchDefault ?? "main",
        required: true,
        style: "short",
        maxLength: 100,
      }),
      modalRow("skills", "Skills (URLs, one per line)", {
        value: skillsDefault,
        style: "paragraph",
      }),
      modalRow("install", "Install command", {
        value: existing?.install?.trim() || "npm ci",
        required: true,
      }),
      modalRow("checks", "Checks (name=cmd per line)", {
        value: checksDefault,
        style: "paragraph",
      }),
    );
}

export function pendingFromRunModal(input: {
  mode: "create" | "update";
  repo: string;
  branch: string;
  skillsRaw: string;
  install: string;
  checksRaw: string;
}): PendingSetupWizard {
  return {
    repo: input.repo,
    branch: input.branch,
    skills: parseSkillLinksInput(input.skillsRaw),
    update: input.mode === "update",
    install: input.install.trim(),
    start: "",
    checks: parseChecksLines(input.checksRaw),
    createdAt: Date.now(),
  };
}

function parseChecksLines(value: string): Record<string, string> {
  const checks: Record<string, string> = {};
  for (const line of value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    const command = line.slice(separator + 1).trim();
    checks[name] = command;
  }
  return checks;
}

export function parseSetupWizardCustomId(
  customId: string,
):
  | { kind: "create-run"; mode: "create" | "update"; userId: string }
  | undefined {
  const parts = customId.split(":");
  if (parts[0] !== "setup" || parts[1] !== "create-run" || parts.length !== 4) {
    return undefined;
  }
  const mode = parts[2];
  if (mode !== "create" && mode !== "update") return undefined;
  const userId = parts[3];
  if (!userId) return undefined;
  return {
    kind: "create-run",
    mode,
    userId,
  };
}
