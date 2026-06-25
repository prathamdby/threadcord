import {
  type SetupDraft,
  type SetupEnvironment,
  type SetupProfile,
  type SetupRun,
  serializeSetupEnvironment,
} from "./profile.js";

export interface SetupStatusViewInput {
  profile: SetupProfile;
  run?: SetupRun;
}

export interface SetupViewModel {
  content: string;
  files?: SetupExportFile[];
}

export interface SetupExportFile {
  name: string;
  content: string;
}

export function renderSetupStatus(input: SetupStatusViewInput): SetupViewModel {
  const { profile, run } = input;
  const runLines =
    run && profile.lastRunId === run.id
      ? [
          "",
          "Last run:",
          `Run status: ${run.status}`,
          `Model: ${run.model}`,
          run.discordThreadId
            ? `Live log: <#${run.discordThreadId}>`
            : undefined,
          run.errorSummary ? `Run error: ${run.errorSummary}` : undefined,
        ]
      : profile.lastRunId
        ? ["", `Last run id: ${profile.lastRunId} (details not loaded)`]
        : ["", "Last run: none"];

  const liveHint =
    profile.status === "running" || profile.status === "updating"
      ? [
          "",
          run?.discordThreadId
            ? `A setup agent is running. Live log: <#${run.discordThreadId}> (or run /setup status again after it finishes).`
            : "A setup agent is running. Open the setup thread on your /setup create or update reply for the live log, or run /setup status again after it finishes.",
        ]
      : [];

  return {
    content: [
      `Setup profile for ${profile.repo} on ${profile.branch}`,
      `Status: ${profile.status}`,
      `Revision: ${profile.revision}`,
      profile.errorSummary ? `Profile error: ${profile.errorSummary}` : undefined,
      ...runLines,
      ...liveHint,
      "",
      "Use /setup view for the full active profile (environment and memory).",
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n"),
  };
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
