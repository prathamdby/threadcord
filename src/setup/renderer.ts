import {
  type SetupDraft,
  type SetupEnvironment,
  type SetupProfile,
  type SetupRun,
  serializeSetupEnvironment,
} from "./profile.js";

export interface SetupViewModel {
  content: string;
  files?: SetupExportFile[];
}

export interface SetupExportFile {
  name: string;
  content: string;
}

export function renderSetupProfile(profile: SetupProfile): SetupViewModel {
  return {
    content: [
      `Setup profile for ${profile.repo} on ${profile.branch}`,
      `Status: ${profile.status}`,
      `Revision: ${profile.revision}`,
      profile.lastRunId ? `Last run: ${profile.lastRunId}` : "Last run: none",
      profile.errorSummary ? `Error: ${profile.errorSummary}` : undefined,
      "",
      renderEnvironment(profile.environment),
      "",
      "Memory preview:",
      preview(profile.memoryMarkdown, 1600),
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n"),
  };
}

export function renderSetupRun(run: SetupRun): SetupViewModel {
  return {
    content: [
      `Setup run for ${run.repo} on ${run.branch}`,
      `Status: ${run.status}`,
      `Model: ${run.model}`,
      `Workspace: ${run.workspacePath}`,
      run.errorSummary ? `Error: ${run.errorSummary}` : undefined,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n"),
  };
}

export function renderDraft(draft: SetupDraft): SetupViewModel {
  return {
    content: [
      `Setup draft ${draft.id}`,
      `Base revision: ${draft.baseRevision}`,
      `Validation: ${draft.validationStatus}`,
      draft.validationMessage ? `Message: ${draft.validationMessage}` : undefined,
      "",
      renderEnvironment(draft.environment),
      "",
      "Memory preview:",
      preview(draft.memoryMarkdown, 1400),
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n"),
  };
}

export function exportProfile(profile: SetupProfile): SetupViewModel {
  return {
    content: `Exported setup profile for ${profile.repo} on ${profile.branch}.`,
    files: [
      {
        name: setupFileName(profile, "environment.json"),
        content: serializeSetupEnvironment(profile.environment),
      },
      {
        name: setupFileName(profile, "memory.md"),
        content: profile.memoryMarkdown,
      },
    ],
  };
}

function renderEnvironment(environment: SetupEnvironment): string {
  const checkLines = Object.entries(environment.checks).map(
    ([name, command]) => `- ${name}: ${command || "(empty)"}`,
  );
  return [
    "Environment:",
    `Install: ${environment.install}`,
    `Start: ${environment.start || "(none)"}`,
    "Checks:",
    ...(checkLines.length > 0 ? checkLines : ["- none"]),
    `Required env: ${environment.requiredEnv.join(", ") || "none"}`,
    `Required services: ${environment.requiredServices.join(", ") || "none"}`,
  ].join("\n");
}

function preview(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 15).trimEnd()}\n...truncated`;
}

function setupFileName(profile: SetupProfile, suffix: string): string {
  return `${profile.repo.replace("/", "-")}-${profile.branch.replace(/\W+/g, "-")}-${suffix}`;
}
