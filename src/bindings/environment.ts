import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hostTool } from "@rivet-dev/agentos-core";
import {
  ENVIRONMENT_ISSUE_KINDS,
  ENVIRONMENT_ISSUE_SEVERITIES,
  type EnvironmentIssue,
  type EnvironmentIssueKind,
  type EnvironmentIssueSeverity,
} from "../agentturn/machine-environment.js";
import type { BindingsHost, HostTool, ToolOutput } from "./types.js";
import { toolResult, toolError } from "./types.js";

const REPORT_ENVIRONMENT_ISSUE_DESCRIPTION =
  "Report a runtime environment blocker. Creates a durable issue and posts a Discord milestone. Prefer request-missing-secret, request-network-access, or report-environment-issue for specific cases.";

const REQUEST_MISSING_SECRET_DESCRIPTION =
  "Report a missing secret or environment variable by name. Creates a durable issue and posts a Discord milestone. Record the name only, never the value.";

const REQUEST_NETWORK_ACCESS_DESCRIPTION =
  "Report a blocked network destination (host and port). Creates a durable issue and posts a Discord milestone. The agent cannot reach this destination.";

const BaseEnvironmentIssueInputSchema = z.object({
  instanceId: z.string().min(1),
  message: z.string().min(1),
});

const ReportEnvironmentIssueInputSchema = z.object({
  instanceId: z.string().min(1),
  kind: z.enum(ENVIRONMENT_ISSUE_KINDS),
  severity: z.enum(ENVIRONMENT_ISSUE_SEVERITIES).optional(),
  message: z.string().min(1),
  requiredEnv: z.array(z.string()).optional(),
  blockedHost: z.string().optional(),
  blockedPort: z.number().int().min(1).max(65535).optional(),
  packageName: z.string().optional(),
  suggestedAction: z.string().optional(),
});

const RequestMissingSecretInputSchema = z.object({
  instanceId: z.string().min(1),
  name: z.string().min(1),
  reason: z.string().min(1),
});

const RequestNetworkAccessInputSchema = z.object({
  instanceId: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  reason: z.string().min(1),
});

export function createReportEnvironmentIssueTool(
  host: BindingsHost,
): HostTool<z.infer<typeof ReportEnvironmentIssueInputSchema>, ToolOutput> {
  return hostTool({
    description: REPORT_ENVIRONMENT_ISSUE_DESCRIPTION,
    inputSchema: ReportEnvironmentIssueInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }
      const issue = buildEnvironmentIssue(resolved, input);
      await host.environmentIssueStore.insert(issue);
      await postEnvironmentMilestone(host, resolved, issue);
      return toolResult({ id: issue.id, status: "reported" });
    },
  });
}

export function createRequestMissingSecretTool(
  host: BindingsHost,
): HostTool<z.infer<typeof RequestMissingSecretInputSchema>, ToolOutput> {
  return hostTool({
    description: REQUEST_MISSING_SECRET_DESCRIPTION,
    inputSchema: RequestMissingSecretInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }
      const issue = buildEnvironmentIssue(resolved, {
        kind: "missing_env",
        severity: "error",
        message: `Missing secret/environment variable: ${input.name}. ${input.reason}`,
        requiredEnv: [input.name],
        suggestedAction: `Set ${input.name} in the host environment and retry.`,
      });
      await host.environmentIssueStore.insert(issue);
      await postEnvironmentMilestone(host, resolved, issue);
      return toolResult({ id: issue.id, status: "reported" });
    },
  });
}

export function createRequestNetworkAccessTool(
  host: BindingsHost,
): HostTool<z.infer<typeof RequestNetworkAccessInputSchema>, ToolOutput> {
  return hostTool({
    description: REQUEST_NETWORK_ACCESS_DESCRIPTION,
    inputSchema: RequestNetworkAccessInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }
      const issue = buildEnvironmentIssue(resolved, {
        kind: "blocked_network",
        severity: "error",
        message: `Network access blocked: ${input.host}:${input.port}. ${input.reason}`,
        blockedHost: input.host,
        blockedPort: input.port,
        suggestedAction: `Allow outbound access to ${input.host}:${input.port} or add it to the network allowlist.`,
      });
      await host.environmentIssueStore.insert(issue);
      await postEnvironmentMilestone(host, resolved, issue);
      return toolResult({ id: issue.id, status: "reported" });
    },
  });
}

function buildEnvironmentIssue(
  resolved: { taskId?: string | undefined; setupRunId?: string | undefined },
  input: {
    kind: EnvironmentIssueKind;
    severity?: EnvironmentIssueSeverity | undefined;
    message: string;
    requiredEnv?: string[] | undefined;
    blockedHost?: string | undefined;
    blockedPort?: number | undefined;
    packageName?: string | undefined;
    suggestedAction?: string | undefined;
  },
): EnvironmentIssue {
  return {
    id: `env-issue-${randomUUID()}`,
    ...(resolved.taskId ? { taskId: resolved.taskId } : {}),
    ...(resolved.setupRunId ? { setupId: resolved.setupRunId } : {}),
    severity: input.severity ?? "error",
    kind: input.kind,
    message: input.message,
    ...(input.requiredEnv ? { requiredEnv: input.requiredEnv } : {}),
    ...(input.blockedHost ? { blockedHost: input.blockedHost } : {}),
    ...(input.blockedPort ? { blockedPort: input.blockedPort } : {}),
    ...(input.packageName ? { packageName: input.packageName } : {}),
    ...(input.suggestedAction ? { suggestedAction: input.suggestedAction } : {}),
    createdAt: new Date(),
  };
}

async function postEnvironmentMilestone(
  host: BindingsHost,
  resolved: { threadId: string },
  issue: EnvironmentIssue,
): Promise<void> {
  const lines = [
    `**Environment issue reported** — \`${issue.kind}\` (${issue.severity})`,
    issue.message,
  ];
  if (issue.suggestedAction) {
    lines.push(`*Suggested action:* ${issue.suggestedAction}`);
  }
  await host.postMessage(resolved.threadId, lines.join("\n\n"));
}

export {
  REPORT_ENVIRONMENT_ISSUE_DESCRIPTION,
  REQUEST_MISSING_SECRET_DESCRIPTION,
  REQUEST_NETWORK_ACCESS_DESCRIPTION,
};
