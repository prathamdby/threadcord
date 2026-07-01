/**
 * Environment fidelity spike helpers.
 *
 * These helpers are spike-only and model the `agent_environment_issues` schema
 * defined in architecture.md. They let the smoke test and unit test share the
 * same classification logic without introducing production code.
 */

export const ENVIRONMENT_ISSUE_KINDS = [
  "missing_env",
  "blocked_network",
  "missing_package",
  "unsupported_arch",
  "native_dependency_failure",
  "toolchain_failure",
] as const;

export type EnvironmentIssueKind = (typeof ENVIRONMENT_ISSUE_KINDS)[number];

export const ENVIRONMENT_ISSUE_SEVERITIES = ["info", "warning", "error"] as const;
export type EnvironmentIssueSeverity = (typeof ENVIRONMENT_ISSUE_SEVERITIES)[number];

/** Spike-level stand-in for the `agent_environment_issues` row. */
export interface EnvironmentIssue {
  id: string;
  taskId?: string;
  setupId?: string;
  severity: EnvironmentIssueSeverity;
  kind: EnvironmentIssueKind;
  message: string;
  requiredEnv?: string[];
  blockedHost?: string;
  blockedPort?: number;
  packageName?: string;
  suggestedAction?: string;
  resolvedAt?: Date;
  createdAt: Date;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Classify a command failure that happened in the agent execution environment.
 *
 * The heuristic looks for native-dependency / toolchain / missing-package
 * signals and returns a typed environment issue rather than a generic failure.
 */
export function classifyCommandFailure(
  command: string,
  result: CommandResult,
  options?: {
    taskId?: string;
    setupId?: string;
    packageName?: string;
  },
): EnvironmentIssue {
  const stderr = normalizeStderr(result.stderr);

  let kind: EnvironmentIssueKind = "native_dependency_failure";
  let packageName = options?.packageName;

  if (stderr.includes("Cannot find module") || stderr.includes("cannot find module")) {
    kind = "missing_package";
    packageName ??= extractMissingModule(stderr);
  } else if (stderr.includes("command not found") || stderr.includes("not found")) {
    kind = "missing_package";
    packageName ??= command.split(/\s+/)[0];
  } else if (stderr.includes("unsupported architecture") || stderr.includes("wrong architecture")) {
    kind = "unsupported_arch";
  } else if (stderr.includes("ECONNREFUSED") || stderr.includes("ENOTFOUND") || stderr.includes("getaddrinfo")) {
    kind = "blocked_network";
  }

  const issue: EnvironmentIssue = {
    id: `env-issue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    severity: "error",
    kind,
    message: `AgentOS execution environment failed to run "${command}": ${stderr.slice(0, 200)}`,
    suggestedAction: suggestAction(kind, packageName),
    createdAt: new Date(),
  };

  if (options?.taskId !== undefined) issue.taskId = options.taskId;
  if (options?.setupId !== undefined) issue.setupId = options.setupId;
  if (packageName !== undefined) issue.packageName = packageName;

  return issue;
}

function normalizeStderr(stderr: string): string {
  // Strip the common AgentOS child-process warning that leaks into stderr.
  // It may contain literal brackets or ANSI escape sequences, and may appear
  // on its own line or inline, so we drop any line containing the warning text.
  return stderr
    .split(/\r?\n/)
    .filter((line) => !line.includes("could not retrieve pid for child process"))
    .join("\n")
    .trim();
}

function extractMissingModule(stderr: string): string | undefined {
  const match = stderr.match(/Cannot find module ['"]([^'"]+)['"]/);
  return match?.[1];
}

function suggestAction(kind: EnvironmentIssueKind, packageName?: string): string {
  switch (kind) {
    case "missing_package":
      return packageName
        ? `Verify ${packageName} is available in the AgentOS execution environment or enable a self-hosted fallback (host/Docker) for this setup profile.`
        : "Verify the required package/toolchain is available in the AgentOS execution environment or enable a self-hosted fallback.";
    case "unsupported_arch":
      return "Use a self-hosted sandbox with the target architecture (linux/arm64) or mark the profile as unsupported on this host.";
    case "blocked_network":
      return "Check host egress rules and required services; add reachable endpoints to the profile's required services list.";
    case "native_dependency_failure":
      return "Enable a self-hosted fallback (host-command binding or Docker sandbox) for native compilation or toolchain steps.";
    default:
      return "Review the environment issue and update the setup profile accordingly.";
  }
}
