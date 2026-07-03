import { infoView, kvView, type ViewPayload } from "../discord/ui/index.js";
import {
  type SetupEnvironment,
  type SetupProfile,
  type SetupRun,
  serializeSetupEnvironment,
} from "./profile.js";

export interface SetupStatusViewInput {
  profile: SetupProfile;
  run?: SetupRun;
}

export interface SetupExportFile {
  name: string;
  content: string;
}

export function renderSetupStatus(input: SetupStatusViewInput): ViewPayload {
  const { profile, run } = input;
  const entries: [string, string][] = [
    ["Repository", `${profile.repo} @ ${profile.branch}`],
    ["Status", profile.status],
    ["Revision", String(profile.revision)],
  ];
  if (profile.errorSummary) {
    entries.push(["Profile error", profile.errorSummary]);
  }
  if (run && profile.lastRunId === run.id) {
    entries.push(["Run status", run.status]);
    entries.push(["Model", run.model]);
    if (run.discordThreadId) {
      entries.push(["Live log", `<#${run.discordThreadId}>`]);
    }
    if (run.errorSummary) {
      entries.push(["Run error", run.errorSummary]);
    }
  } else if (profile.lastRunId) {
    entries.push(["Last run id", `${profile.lastRunId} (details not loaded)`]);
  } else {
    entries.push(["Last run", "none"]);
  }
  if (profile.status === "running" || profile.status === "updating") {
    entries.push([
      "Live setup",
      run?.discordThreadId
        ? `A setup agent is running. Live log: <#${run.discordThreadId}> (or run /setup status again after it finishes).`
        : "A setup agent is running. Open the setup thread on your /setup create or update reply for the live log, or run /setup status again after it finishes.",
    ]);
  }
  return kvView("Setup status", entries);
}

export function renderSetupProfile(profile: SetupProfile): ViewPayload {
  return infoView(
    `Setup profile for ${profile.repo} on ${profile.branch}`,
    [
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
  );
}

export function formatSetupProfileThreadPost(profile: SetupProfile): string {
  return [
    `Setup profile for ${profile.repo} on ${profile.branch}`,
    `Status: ${profile.status}`,
    `Revision: ${profile.revision}`,
    profile.errorSummary ? `Error: ${profile.errorSummary}` : undefined,
    "",
    `Install: ${profile.environment.install}`,
    `Checks: ${
      Object.keys(profile.environment.checks).length > 0
        ? Object.keys(profile.environment.checks).join(", ")
        : "none"
    }`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

export function renderSetupRun(run: SetupRun): ViewPayload {
  return kvView(`Setup run for ${run.repo} on ${run.branch}`, [
    ["Status", run.status],
    ["Model", run.model],
    ["Workspace", run.workspacePath],
    ...(run.errorSummary ? [["Error", run.errorSummary] as [string, string]] : []),
  ]);
}

export function exportProfile(profile: SetupProfile): {
  view: ViewPayload;
  files: SetupExportFile[];
} {
  return {
    view: infoView(
      "Setup export",
      `Exported setup profile for ${profile.repo} on ${profile.branch}. Download the attached environment JSON and memory Markdown files.`,
    ),
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

export function renderEnvironment(environment: SetupEnvironment): string {
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
    `Skills: ${
      environment.skills && environment.skills.length > 0
        ? environment.skills.join("; ")
        : "(none)"
    }`,
  ].join("\n");
}

function preview(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 15).trimEnd()}\n...truncated`;
}

function setupFileName(profile: SetupProfile, suffix: string): string {
  return `${profile.repo.replace("/", "-")}-${profile.branch.replace(/\W+/g, "-")}-${suffix}`;
}
