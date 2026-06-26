import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { SetupEnvironment } from "./profile.js";
import { parseSkillLinksInput } from "./skills.js";

const SETUP_PREFIX = "setup:";

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
    .setCustomId(`${SETUP_PREFIX}create-run:${mode}:${userId}`)
    .setTitle(mode === "create" ? "Setup create" : "Setup update")
    .addComponents(
      modalRow(
        "repo",
        "Repository (owner/repo)",
        repoDefault ?? "",
        100,
        true,
        TextInputStyle.Short,
      ),
      modalRow(
        "branch",
        "Base branch",
        branchDefault ?? "main",
        100,
        true,
        TextInputStyle.Short,
      ),
      modalRow(
        "skills",
        "Skills (URLs, one per line)",
        skillsDefault,
        4000,
        false,
        TextInputStyle.Paragraph,
      ),
      modalRow(
        "install",
        "Install command",
        existing?.install?.trim() || "npm ci",
        4000,
        true,
        TextInputStyle.Paragraph,
      ),
      modalRow(
        "checks",
        "Checks (name=cmd per line)",
        checksDefault,
        4000,
        false,
        TextInputStyle.Paragraph,
      ),
    );
}

function modalRow(
  customId: string,
  label: string,
  value: string,
  maxLength: number,
  required: boolean,
  style: TextInputStyle = TextInputStyle.Paragraph,
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label.slice(0, 45))
      .setValue(value.slice(0, maxLength))
      .setMaxLength(maxLength)
      .setRequired(required)
      .setStyle(style),
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
  if (!customId.startsWith(SETUP_PREFIX)) return undefined;
  const rest = customId.slice(SETUP_PREFIX.length);
  const parts = rest.split(":");
  if (parts[0] === "create-run" && parts.length === 3) {
    const mode = parts[1];
    if (mode !== "create" && mode !== "update") return undefined;
    const userId = parts[2];
    if (!userId) return undefined;
    return {
      kind: "create-run",
      mode: mode as "create" | "update",
      userId,
    };
  }
  return undefined;
}
