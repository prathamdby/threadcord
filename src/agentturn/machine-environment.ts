import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { z } from "zod";
import type { TaskRecord } from "../types.js";
import type { SetupProfile } from "../setup/profile.js";
import { buildSkillsInstallShellCommand } from "../setup/skills.js";
import type { AppConfig } from "../config.js";
import { workspaceEnv, workspacePaths } from "../task/workspace-env.js";
import {
  bootstrapWorkspace,
  runSetupInstall,
  runSetupSkillsInstall,
  type BootstrapMode,
} from "../task/bootstrap.js";
import type { AgentTurnRole } from "./types.js";
import type { FallbackExecutor } from "./fallback.js";

export const ENVIRONMENT_ISSUE_SEVERITIES = ["info", "warning", "error"] as const;
export type EnvironmentIssueSeverity =
  (typeof ENVIRONMENT_ISSUE_SEVERITIES)[number];

export const ENVIRONMENT_ISSUE_KINDS = [
  "missing_env",
  "blocked_network",
  "missing_package",
  "unsupported_arch",
  "native_dependency_failure",
  "toolchain_failure",
  "resource_memory",
  "resource_disk",
  "resource_vm_capacity",
  "sidecar_not_found",
  "sidecar_not_executable",
  "sidecar_arch_mismatch",
  "mcp_config_unparseable",
  "credentials_missing",
  "sandbox_unavailable",
] as const;
export type EnvironmentIssueKind = (typeof ENVIRONMENT_ISSUE_KINDS)[number];

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

export interface EnvironmentIssueStore {
  insert(issue: EnvironmentIssue): Promise<void>;
  listUnresolved(): Promise<EnvironmentIssue[]>;
  resolve(id: string): Promise<void>;
}

export interface InMemoryEnvironmentIssueStore extends EnvironmentIssueStore {
  issues: EnvironmentIssue[];
}

export class MemoryEnvironmentIssueStore implements InMemoryEnvironmentIssueStore {
  readonly issues: EnvironmentIssue[] = [];

  async insert(issue: EnvironmentIssue): Promise<void> {
    this.issues.push({ ...issue });
  }

  async listUnresolved(): Promise<EnvironmentIssue[]> {
    return this.issues.filter((issue) => issue.resolvedAt === undefined);
  }

  async resolve(id: string): Promise<void> {
    const issue = this.issues.find((i) => i.id === id);
    if (issue) issue.resolvedAt = new Date();
  }
}

const EnvironmentIssueSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().optional(),
  setupId: z.string().optional(),
  severity: z.enum(ENVIRONMENT_ISSUE_SEVERITIES),
  kind: z.enum(ENVIRONMENT_ISSUE_KINDS),
  message: z.string().min(1),
  requiredEnv: z.array(z.string()).optional(),
  blockedHost: z.string().optional(),
  blockedPort: z.number().int().optional(),
  packageName: z.string().optional(),
  suggestedAction: z.string().optional(),
  resolvedAt: z.date().optional(),
  createdAt: z.date(),
});

export function validateEnvironmentIssue(
  issue: unknown,
): EnvironmentIssue {
  return EnvironmentIssueSchema.parse(issue) as EnvironmentIssue;
}

export function isEnvironmentIssueKind(value: unknown): value is EnvironmentIssueKind {
  return typeof value === "string" && (ENVIRONMENT_ISSUE_KINDS as readonly string[]).includes(value);
}

export function isEnvironmentIssueSeverity(value: unknown): value is EnvironmentIssueSeverity {
  return typeof value === "string" && (ENVIRONMENT_ISSUE_SEVERITIES as readonly string[]).includes(value);
}

export interface ResourceSnapshot {
  rssBytes: number;
  freeMemoryMb: number;
  freeDiskMb: number;
  loadAverage: number[];
  workspaceSizeBytes: number;
  sidecarCount: number;
  activeVmCount: number;
}

export interface ResourceSnapshotProvider {
  getSnapshot(): Promise<ResourceSnapshot>;
}

export interface FilesystemSnapshot {
  workspaceExists: boolean;
  workspaceWritable: boolean;
  checkoutExists: boolean;
  installMarker: boolean;
}

export interface FilesystemSnapshotProvider {
  getSnapshot(workspacePath: string, checkoutPath: string): Promise<FilesystemSnapshot>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandExecutor {
  run(command: string, cwd: string): Promise<CommandResult>;
}

export interface SidecarInfo {
  path: string;
  executable: boolean;
  arch: string;
}

export interface SidecarResolver {
  resolve(): Promise<SidecarInfo>;
}

export interface McpConfigProvider {
  getPath(): Promise<string>;
  parse(): Promise<unknown>;
}

export interface CredentialsProvider {
  hasCredentials(model: string): Promise<boolean>;
}

export interface ServiceProbe {
  check(host: string, port: number): Promise<boolean>;
}

export interface WorkspaceBootstrapper {
  bootstrap(task: TaskRecord, mode: BootstrapMode): Promise<string>;
}

export interface InstallRunner {
  run(
    workspacePath: string,
    checkoutPath: string,
    installCommand: string,
    githubToken: string,
  ): Promise<void>;
}

export interface SkillsInstallRunner {
  run(
    workspacePath: string,
    checkoutPath: string,
    skillLinks: string[],
    githubToken: string,
  ): Promise<void>;
}

export interface Logger {
  log(level: string, message: string, meta?: Record<string, unknown>): void;
}

export interface PrepareInput {
  instanceId: string;
  role: AgentTurnRole;
  task: TaskRecord;
  source: "initial" | "followup";
  setupProfile: SetupProfile;
  model: string;
}

export interface PrepareSuccess {
  ready: true;
  workspacePath: string;
  checkoutPath: string;
  env: NodeJS.ProcessEnv;
  homePath: string;
  npmPrefixPath: string;
}

export interface PrepareFailure {
  ready: false;
  reason: string;
  issue?: EnvironmentIssue;
}

export type PrepareResult = PrepareSuccess | PrepareFailure;

export interface MachineEnvironment {
  prepare(input: PrepareInput): Promise<PrepareResult>;
  getResourceSnapshot(): Promise<ResourceSnapshot>;
  logResourceSample(tag: "start" | "end", instanceId: string): Promise<void>;
  reportIssue(issue: EnvironmentIssue): Promise<void>;
}

export interface MachineEnvironmentConfig {
  maxActiveVms: number;
  reservedSystemMemoryMb: number;
  minFreeDiskMb: number;
  sandboxEnabled: boolean;
  githubToken: string;
}

function defaultConfigFromAppConfig(config: AppConfig): MachineEnvironmentConfig {
  return {
    maxActiveVms: 2,
    reservedSystemMemoryMb: 4096,
    minFreeDiskMb: 2048,
    sandboxEnabled: config.AGENTOS_SANDBOX_ENABLE ?? false,
    githubToken: config.GITHUB_TOKEN,
  };
}

export interface DefaultMachineEnvironmentDependencies {
  bootstrapper?: WorkspaceBootstrapper;
  installRunner?: InstallRunner;
  skillsInstallRunner?: SkillsInstallRunner;
  resourceSnapshotProvider?: ResourceSnapshotProvider;
  filesystemSnapshotProvider?: FilesystemSnapshotProvider;
  commandExecutor?: CommandExecutor;
  sidecarResolver?: SidecarResolver;
  mcpConfigProvider?: McpConfigProvider;
  credentialsProvider?: CredentialsProvider;
  serviceProbe?: ServiceProbe;
  fallbackExecutor?: FallbackExecutor;
  issueStore?: EnvironmentIssueStore;
  logger?: Logger;
}

export class DefaultMachineEnvironment implements MachineEnvironment {
  private readonly config: MachineEnvironmentConfig;
  private readonly bootstrapper: WorkspaceBootstrapper;
  private readonly installRunner: InstallRunner;
  private readonly skillsInstallRunner: SkillsInstallRunner | undefined;
  private readonly resourceSnapshotProvider: ResourceSnapshotProvider;
  private readonly filesystemSnapshotProvider: FilesystemSnapshotProvider;
  private readonly commandExecutor: CommandExecutor;
  private readonly sidecarResolver: SidecarResolver;
  private readonly mcpConfigProvider: McpConfigProvider | undefined;
  private readonly credentialsProvider: CredentialsProvider;
  private readonly serviceProbe: ServiceProbe;
  private readonly fallbackExecutor: FallbackExecutor | undefined;
  private readonly issueStore: EnvironmentIssueStore | undefined;
  private readonly logger: Logger;

  constructor(
    config: AppConfig | MachineEnvironmentConfig,
    deps: DefaultMachineEnvironmentDependencies = {},
  ) {
    this.config =
      "maxActiveVms" in config
        ? (config as MachineEnvironmentConfig)
        : defaultConfigFromAppConfig(config as AppConfig);
    this.bootstrapper = deps.bootstrapper ?? defaultBootstrapper();
    this.installRunner = deps.installRunner ?? defaultInstallRunner();
    this.skillsInstallRunner = deps.skillsInstallRunner;
    this.resourceSnapshotProvider =
      deps.resourceSnapshotProvider ?? defaultResourceSnapshotProvider();
    this.filesystemSnapshotProvider =
      deps.filesystemSnapshotProvider ?? defaultFilesystemSnapshotProvider();
    this.commandExecutor = deps.commandExecutor ?? defaultCommandExecutor();
    this.sidecarResolver = deps.sidecarResolver ?? defaultSidecarResolver();
    this.mcpConfigProvider = deps.mcpConfigProvider;
    this.credentialsProvider =
      deps.credentialsProvider ?? defaultCredentialsProvider();
    this.serviceProbe = deps.serviceProbe ?? defaultServiceProbe();
    this.fallbackExecutor = deps.fallbackExecutor;
    this.issueStore = deps.issueStore;
    this.logger = deps.logger ?? consoleLogger();
  }

  async getResourceSnapshot(): Promise<ResourceSnapshot> {
    return this.resourceSnapshotProvider.getSnapshot();
  }

  async logResourceSample(tag: "start" | "end", instanceId: string): Promise<void> {
    const snapshot = await this.getResourceSnapshot();
    this.logger.log("info", `resource-sample:${tag}`, {
      instanceId,
      rss: snapshot.rssBytes,
      freeMemoryMb: snapshot.freeMemoryMb,
      loadAverage: snapshot.loadAverage,
      workspaceSizeBytes: snapshot.workspaceSizeBytes,
      sidecarCount: snapshot.sidecarCount,
      activeVmCount: snapshot.activeVmCount,
    });
  }

  async reportIssue(issue: EnvironmentIssue): Promise<void> {
    await this.issueStore?.insert(validateEnvironmentIssue(issue));
  }

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const resourceSnapshot = await this.getResourceSnapshot();

    const admission = evaluateResourceAdmission(
      resourceSnapshot,
      this.config,
      input.instanceId,
    );
    if (!admission.ok) {
      return admission.failure;
    }

    const nativeExecution =
      input.setupProfile.environment.requiresNativeExecution ?? false;
    if (nativeExecution && !this.config.sandboxEnabled) {
      return sandboxUnavailableFailure(input.instanceId);
    }
    if (nativeExecution && !this.fallbackExecutor) {
      return sandboxUnavailableFailure(input.instanceId);
    }

    const checkoutPath = join(input.task.workspacePath, basename(input.task.repo));

    if (input.source === "initial") {
      await this.bootstrapper.bootstrap(input.task, "initial");
      if (nativeExecution) {
        await this.fallbackExecutor!.run(
          input.setupProfile.environment.install,
          checkoutPath,
        );
      } else {
        await this.installRunner.run(
          input.task.workspacePath,
          checkoutPath,
          input.setupProfile.environment.install,
          this.config.githubToken,
        );
      }
      if (input.setupProfile.environment.skills) {
        if (nativeExecution) {
          const skillsCommand = buildSkillsInstallShellCommand(
            input.setupProfile.environment.skills,
          );
          await this.fallbackExecutor!.run(skillsCommand, checkoutPath);
        } else {
          await this.skillsInstallRunner?.run(
            input.task.workspacePath,
            checkoutPath,
            input.setupProfile.environment.skills,
            this.config.githubToken,
          );
        }
      }
    } else {
      await this.bootstrapper.bootstrap(input.task, "continue");
    }

    const probe = await runReadinessProbe({
      input,
      checkoutPath,
      filesystemSnapshotProvider: this.filesystemSnapshotProvider,
      commandExecutor: this.commandExecutor,
      sidecarResolver: this.sidecarResolver,
      mcpConfigProvider: this.mcpConfigProvider,
      credentialsProvider: this.credentialsProvider,
      serviceProbe: this.serviceProbe,
      config: this.config,
      fallbackExecutor: this.fallbackExecutor,
    });

    if (!probe.ok) {
      return probe.failure;
    }

    await this.logResourceSample("start", input.instanceId);

    const paths = workspacePaths(input.task.workspacePath);
    const env = workspaceEnv(input.task.workspacePath, {
      // Model credentials are made available to the agent; host-only secrets
      // like GITHUB_TOKEN stay out of the guest env via workspaceEnv defaults.
    });

    return {
      ready: true,
      workspacePath: input.task.workspacePath,
      checkoutPath,
      env,
      homePath: paths.home,
      npmPrefixPath: paths.npmPrefix,
    };
  }
}

function defaultBootstrapper(): WorkspaceBootstrapper {
  return {
    bootstrap: async () => {
      throw new Error(
        "No workspace bootstrapper configured for MachineEnvironment",
      );
    },
  };
}

function defaultInstallRunner(): InstallRunner {
  return {
    run: async () => {
      throw new Error("No install runner configured for MachineEnvironment");
    },
  };
}

function defaultResourceSnapshotProvider(): ResourceSnapshotProvider {
  return {
    getSnapshot: async () => ({
      rssBytes: 0,
      freeMemoryMb: Number.MAX_SAFE_INTEGER,
      freeDiskMb: Number.MAX_SAFE_INTEGER,
      loadAverage: [0, 0, 0],
      workspaceSizeBytes: 0,
      sidecarCount: 0,
      activeVmCount: 0,
    }),
  };
}

function defaultFilesystemSnapshotProvider(): FilesystemSnapshotProvider {
  return {
    getSnapshot: async () => ({
      workspaceExists: true,
      workspaceWritable: true,
      checkoutExists: true,
      installMarker: true,
    }),
  };
}

function defaultCommandExecutor(): CommandExecutor {
  return {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

function defaultSidecarResolver(): SidecarResolver {
  return {
    resolve: async () => ({
      path: "/opt/agentos-sidecar",
      executable: true,
      arch: "arm64",
    }),
  };
}

function defaultCredentialsProvider(): CredentialsProvider {
  return {
    hasCredentials: async () => true,
  };
}

function defaultServiceProbe(): ServiceProbe {
  return {
    check: async (host, port) => {
      return new Promise((resolve) => {
        const socket = createConnection(port, host);
        let settled = false;
        const finish = (value: boolean): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(value);
        };
        socket.on("connect", () => finish(true));
        socket.on("error", () => finish(false));
        socket.setTimeout(5000, () => finish(false));
      });
    },
  };
}

function consoleLogger(): Logger {
  return {
    log: (level, message, meta) => {
      console.log(`[threadcord] ${level}: ${message}`, meta ?? "");
    },
  };
}

function silentLogger(): Logger {
  return {
    log: () => {},
  };
}

interface AdmissionFailure {
  ok: false;
  failure: PrepareFailure;
}

interface AdmissionSuccess {
  ok: true;
}

function evaluateResourceAdmission(
  snapshot: ResourceSnapshot,
  config: MachineEnvironmentConfig,
  instanceId: string,
): AdmissionSuccess | AdmissionFailure {
  if (snapshot.activeVmCount >= config.maxActiveVms) {
    return {
      ok: false,
      failure: {
        ready: false,
        reason: "too many active VMs",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "resource_vm_capacity",
          message: `Cannot start turn for ${instanceId}: active VM count (${snapshot.activeVmCount}) is at or above MAX_ACTIVE_VMS (${config.maxActiveVms}).`,
          suggestedAction: "Wait for an active VM to finish or increase MAX_ACTIVE_VMS.",
          createdAt: new Date(),
        },
      },
    };
  }

  if (snapshot.freeMemoryMb < config.reservedSystemMemoryMb) {
    return {
      ok: false,
      failure: {
        ready: false,
        reason: "insufficient free memory",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "resource_memory",
          message: `Cannot start turn for ${instanceId}: free memory (${snapshot.freeMemoryMb} MB) is below the reserved system headroom (${config.reservedSystemMemoryMb} MB).`,
          suggestedAction: "Free memory or increase RESERVED_SYSTEM_MEMORY_MB.",
          createdAt: new Date(),
        },
      },
    };
  }

  if (snapshot.freeDiskMb < config.minFreeDiskMb) {
    return {
      ok: false,
      failure: {
        ready: false,
        reason: "insufficient free disk",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "resource_disk",
          message: `Cannot start turn for ${instanceId}: free disk (${snapshot.freeDiskMb} MB) is below MIN_FREE_DISK_MB (${config.minFreeDiskMb} MB).`,
          suggestedAction: "Free disk space or increase MIN_FREE_DISK_MB.",
          createdAt: new Date(),
        },
      },
    };
  }

  return { ok: true };
}

function sandboxUnavailableFailure(instanceId: string): PrepareFailure {
  return {
    ready: false,
    reason: "sandbox fallback is not enabled",
    issue: {
      id: `env-issue-${randomUUID()}`,
      severity: "error",
      kind: "sandbox_unavailable",
      message: `Profile requires native execution but AGENTOS_SANDBOX_ENABLE is not set for ${instanceId}.`,
      suggestedAction: "Enable AGENTOS_SANDBOX_ENABLE and configure a self-hosted fallback executor.",
      createdAt: new Date(),
    },
  };
}

interface ProbeFailure {
  ok: false;
  failure: PrepareFailure;
}

interface ProbeSuccess {
  ok: true;
}

interface ReadinessProbeContext {
  input: PrepareInput;
  checkoutPath: string;
  filesystemSnapshotProvider: FilesystemSnapshotProvider;
  commandExecutor: CommandExecutor;
  sidecarResolver: SidecarResolver;
  mcpConfigProvider: McpConfigProvider | undefined;
  credentialsProvider: CredentialsProvider;
  serviceProbe: ServiceProbe;
  config: MachineEnvironmentConfig;
  fallbackExecutor: FallbackExecutor | undefined;
}

async function runReadinessProbe(
  ctx: ReadinessProbeContext,
): Promise<ProbeSuccess | ProbeFailure> {
  const { input, checkoutPath } = ctx;
  const nativeExecution =
    input.setupProfile.environment.requiresNativeExecution ?? false;

  const fs = await ctx.filesystemSnapshotProvider.getSnapshot(
    input.task.workspacePath,
    checkoutPath,
  );

  if (!fs.workspaceExists || !fs.workspaceWritable) {
    return {
      ok: false,
      failure: {
        ready: false,
        reason: "workspace is not ready",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "missing_package",
          message: `Workspace ${input.task.workspacePath} is missing or not writable.`,
          suggestedAction: "Verify the workspace directory exists and is writable.",
          createdAt: new Date(),
        },
      },
    };
  }

  if (!fs.checkoutExists) {
    return {
      ok: false,
      failure: {
        ready: false,
        reason: "repo checkout is missing",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "missing_package",
          message: `Repo checkout ${checkoutPath} is missing.`,
          suggestedAction: "Re-run the initial workspace bootstrap.",
          createdAt: new Date(),
        },
      },
    };
  }

  const runFullProbe = input.source === "initial" && input.role === "coding";

  if (runFullProbe) {
    if (!fs.installMarker) {
      return {
        ok: false,
        failure: {
          ready: false,
          reason: "setup install has not run",
          issue: {
            id: `env-issue-${randomUUID()}`,
            severity: "error",
            kind: "missing_package",
            message: `Setup install command has not completed for ${input.task.workspacePath}.`,
            suggestedAction: "Re-run the setup install step.",
            createdAt: new Date(),
          },
        },
      };
    }

    for (const [name, command] of Object.entries(
      input.setupProfile.environment.checks,
    )) {
      const result = nativeExecution
        ? await ctx.fallbackExecutor!.run(command, checkoutPath)
        : await ctx.commandExecutor.run(command, checkoutPath);
      if (result.exitCode !== 0) {
        return {
          ok: false,
          failure: {
            ready: false,
            reason: `setup check ${name} failed`,
            issue: {
              id: `env-issue-${randomUUID()}`,
              severity: "error",
              kind: "toolchain_failure",
              message: `Setup check ${name} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
              suggestedAction: "Verify the check command is available and correct in the checkout directory.",
              createdAt: new Date(),
            },
          },
        };
      }
    }

    for (const name of input.setupProfile.environment.requiredEnv) {
      if (!process.env[name]) {
        return {
          ok: false,
          failure: {
            ready: false,
            reason: `required environment variable ${name} is missing`,
            issue: {
              id: `env-issue-${randomUUID()}`,
              severity: "error",
              kind: "missing_env",
              message: `Required environment variable ${name} is not set.`,
              requiredEnv: [name],
              suggestedAction: `Set ${name} in the host environment or mark it as explicitly missing.`,
              createdAt: new Date(),
            },
          },
        };
      }
    }

    for (const service of input.setupProfile.environment.requiredServices) {
      const [host, portStr] = service.split(":");
      const port = Number.parseInt(portStr ?? "", 10);
      if (!host || Number.isNaN(port)) {
        return {
          ok: false,
          failure: {
            ready: false,
            reason: `required service ${service} has invalid format`,
            issue: {
              id: `env-issue-${randomUUID()}`,
              severity: "error",
              kind: "blocked_network",
              message: `Required service ${service} is not in host:port format.`,
              suggestedAction: "Use host:port format for required services.",
              createdAt: new Date(),
              ...(host ? { blockedHost: host } : {}),
              ...(Number.isNaN(port) ? {} : { blockedPort: port }),
            },
          },
        };
      }
      const reachable = await ctx.serviceProbe.check(host, port);
      if (!reachable) {
        return {
          ok: false,
          failure: {
            ready: false,
            reason: `required service ${service} is unreachable`,
            issue: {
              id: `env-issue-${randomUUID()}`,
              severity: "error",
              kind: "blocked_network",
              message: `Required service ${service} is unreachable.`,
              blockedHost: host,
              blockedPort: port,
              suggestedAction: "Verify the service is running and reachable from the host.",
              createdAt: new Date(),
            },
          },
        };
      }
    }
  }

  const sidecar = await ctx.sidecarResolver.resolve();
  if (!sidecar.executable) {
    return {
      ok: false,
      failure: {
        ready: false,
        reason: "AgentOS sidecar is not executable",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "sidecar_not_executable",
          message: `AgentOS sidecar at ${sidecar.path} is not executable.`,
          suggestedAction: "Verify the sidecar binary is present and executable.",
          createdAt: new Date(),
        },
      },
    };
  }

  if (sidecar.arch !== "arm64") {
    return {
      ok: false,
      failure: {
        ready: false,
        reason: "AgentOS sidecar architecture mismatch",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "sidecar_arch_mismatch",
          message: `AgentOS sidecar at ${sidecar.path} has architecture ${sidecar.arch}, expected arm64.`,
          suggestedAction: "Provide an arm64 sidecar binary.",
          createdAt: new Date(),
        },
      },
    };
  }

  const credentialsOk = await ctx.credentialsProvider.hasCredentials(input.model);
  if (!credentialsOk) {
    return {
      ok: false,
      failure: {
        ready: false,
        reason: "model credentials are not available",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "credentials_missing",
          message: `No credentials available for model ${input.model}.`,
          suggestedAction: "Configure the provider API key for the selected model.",
          createdAt: new Date(),
        },
      },
    };
  }

  if (ctx.mcpConfigProvider) {
    try {
      await ctx.mcpConfigProvider.parse();
    } catch {
      return {
        ok: false,
        failure: {
          ready: false,
          reason: "MCP config is not parseable",
          issue: {
            id: `env-issue-${randomUUID()}`,
            severity: "error",
            kind: "mcp_config_unparseable",
            message: `MCP config at ${await ctx.mcpConfigProvider.getPath()} is not valid JSON.`,
            suggestedAction: "Re-materialize the MCP config before the next turn.",
            createdAt: new Date(),
          },
        },
      };
    }
  }

  if (nativeExecution && (!ctx.config.sandboxEnabled || !ctx.fallbackExecutor)) {
    return {
      ok: false,
      failure: sandboxUnavailableFailure(input.instanceId),
    };
  }

  return { ok: true };
}

export interface FakeMachineEnvironmentOptions {
  resourceSnapshot?: ResourceSnapshot;
  filesystemSnapshot?: FilesystemSnapshot;
  sidecarInfo?: SidecarInfo;
  credentialsAvailable?: boolean;
  mcpConfigValid?: boolean;
  commandResults?: Record<string, CommandResult>;
  serviceReachability?: Record<string, boolean>;
  issueStore?: EnvironmentIssueStore;
  logger?: Logger;
  failReadinessCheck?: string;
  failAdmission?: boolean;
  sandboxEnabled?: boolean;
  fallbackExecutor?: FallbackExecutor;
}

export class FakeMachineEnvironment implements MachineEnvironment {
  readonly prepared: PrepareInput[] = [];
  readonly bootstrapCalls: { taskId: string; mode: BootstrapMode }[] = [];
  readonly installCalls: {
    workspacePath: string;
    checkoutPath: string;
    installCommand: string;
  }[] = [];
  readonly skillsInstallCalls: {
    workspacePath: string;
    checkoutPath: string;
    skillLinks: string[];
  }[] = [];
  readonly resourceSamples: { tag: "start" | "end"; instanceId: string; snapshot: ResourceSnapshot }[] = [];
  readonly issues: EnvironmentIssue[] = [];
  readonly fallbackCalls: { command: string; cwd: string }[] = [];

  private resourceSnapshot: ResourceSnapshot;
  private filesystemSnapshot: FilesystemSnapshot;
  private sidecarInfo: SidecarInfo;
  private credentialsAvailable: boolean;
  private mcpConfigValid: boolean;
  private commandResults: Record<string, CommandResult>;
  private serviceReachability: Record<string, boolean>;
  private failReadinessCheck: string | undefined;
  private failAdmission: boolean;
  private sandboxEnabled: boolean;
  private fallbackExecutor: FallbackExecutor | undefined;
  private issueStore: EnvironmentIssueStore | undefined;
  private logger: Logger;
  private blockNextPrepareFlag = false;
  private nextPrepareBlock:
    | { resolve: () => void; reject: (err: Error) => void }
    | undefined;

  constructor(options: FakeMachineEnvironmentOptions = {}) {
    this.resourceSnapshot = options.resourceSnapshot ?? {
      rssBytes: 0,
      freeMemoryMb: Number.MAX_SAFE_INTEGER,
      freeDiskMb: Number.MAX_SAFE_INTEGER,
      loadAverage: [0, 0, 0],
      workspaceSizeBytes: 0,
      sidecarCount: 0,
      activeVmCount: 0,
    };
    this.filesystemSnapshot = options.filesystemSnapshot ?? {
      workspaceExists: true,
      workspaceWritable: true,
      checkoutExists: true,
      installMarker: true,
    };
    this.sidecarInfo = options.sidecarInfo ?? {
      path: "/opt/agentos-sidecar",
      executable: true,
      arch: "arm64",
    };
    this.credentialsAvailable = options.credentialsAvailable ?? true;
    this.mcpConfigValid = options.mcpConfigValid ?? true;
    this.commandResults = options.commandResults ?? {};
    this.serviceReachability = options.serviceReachability ?? {};
    this.failReadinessCheck = options.failReadinessCheck;
    this.failAdmission = options.failAdmission ?? false;
    this.sandboxEnabled = options.sandboxEnabled ?? false;
    this.fallbackExecutor = options.fallbackExecutor;
    this.issueStore = options.issueStore;
    this.logger = options.logger ?? silentLogger();
  }

  /**
   * Block the next prepare() call until release() is called.
   * Useful for testing cancellations that race with setup/bootstrap.
   */
  blockNextPrepare(): { release: () => void } {
    this.blockNextPrepareFlag = true;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.nextPrepareBlock?.resolve();
      this.nextPrepareBlock = undefined;
    };
    return { release };
  }

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    this.prepared.push(input);
    const checkoutPath = join(input.task.workspacePath, basename(input.task.repo));
    const nativeExecution =
      input.setupProfile.environment.requiresNativeExecution ?? false;

    if (nativeExecution && (!this.sandboxEnabled || !this.fallbackExecutor)) {
      return sandboxUnavailableFailure(input.instanceId);
    }

    if (input.source === "initial") {
      this.bootstrapCalls.push({ taskId: input.task.id, mode: "initial" });
      if (nativeExecution) {
        this.fallbackCalls.push({
          command: input.setupProfile.environment.install,
          cwd: checkoutPath,
        });
      } else {
        this.installCalls.push({
          workspacePath: input.task.workspacePath,
          checkoutPath,
          installCommand: input.setupProfile.environment.install,
        });
      }
      if (input.setupProfile.environment.skills) {
        if (nativeExecution) {
          this.fallbackCalls.push({
            command: `install-skills:${input.setupProfile.environment.skills.join(",")}`,
            cwd: checkoutPath,
          });
        } else {
          this.skillsInstallCalls.push({
            workspacePath: input.task.workspacePath,
            checkoutPath,
            skillLinks: input.setupProfile.environment.skills,
          });
        }
      }
    } else {
      this.bootstrapCalls.push({ taskId: input.task.id, mode: "continue" });
    }

    if (this.blockNextPrepareFlag) {
      this.blockNextPrepareFlag = false;
      await new Promise<void>((resolve, reject) => {
        this.nextPrepareBlock = { resolve, reject };
      });
    }

    if (this.failAdmission) {
      return {
        ready: false,
        reason: "admission rejected by fake",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "resource_memory",
          message: "Fake admission rejected the turn.",
          createdAt: new Date(),
        },
      };
    }

    if (this.resourceSnapshot.freeMemoryMb < 4096) {
      return {
        ready: false,
        reason: "insufficient free memory",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "resource_memory",
          message: `Free memory ${this.resourceSnapshot.freeMemoryMb} MB is below 4096 MB.`,
          createdAt: new Date(),
        },
      };
    }

    if (this.resourceSnapshot.freeDiskMb < 2048) {
      return {
        ready: false,
        reason: "insufficient free disk",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "resource_disk",
          message: `Free disk ${this.resourceSnapshot.freeDiskMb} MB is below 2048 MB.`,
          createdAt: new Date(),
        },
      };
    }

    if (this.resourceSnapshot.activeVmCount >= 2) {
      return {
        ready: false,
        reason: "too many active VMs",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "resource_vm_capacity",
          message: `Active VM count ${this.resourceSnapshot.activeVmCount} is at capacity.`,
          createdAt: new Date(),
        },
      };
    }

    if (this.failReadinessCheck) {
      return {
        ready: false,
        reason: this.failReadinessCheck,
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "missing_package",
          message: this.failReadinessCheck,
          createdAt: new Date(),
        },
      };
    }

    if (!this.filesystemSnapshot.workspaceExists || !this.filesystemSnapshot.workspaceWritable) {
      return {
        ready: false,
        reason: "workspace is not ready",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "missing_package",
          message: "Workspace is missing or not writable.",
          createdAt: new Date(),
        },
      };
    }

    if (!this.filesystemSnapshot.checkoutExists) {
      return {
        ready: false,
        reason: "repo checkout is missing",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "missing_package",
          message: "Repo checkout is missing.",
          createdAt: new Date(),
        },
      };
    }

    const runFullProbe = input.source === "initial" && input.role === "coding";

    if (runFullProbe) {
      if (!this.filesystemSnapshot.installMarker) {
        return {
          ready: false,
          reason: "setup install has not run",
          issue: {
            id: `env-issue-${randomUUID()}`,
            severity: "error",
            kind: "missing_package",
            message: "Setup install has not completed.",
            createdAt: new Date(),
          },
        };
      }

      for (const [name, command] of Object.entries(
        input.setupProfile.environment.checks,
      )) {
        const result = nativeExecution
          ? await this.fallbackExecutor!.run(command, checkoutPath)
          : this.commandResults[command] ?? {
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
        if (nativeExecution) {
          this.fallbackCalls.push({ command, cwd: checkoutPath });
        }
        if (result.exitCode !== 0) {
          return {
            ready: false,
            reason: `setup check ${name} failed`,
            issue: {
              id: `env-issue-${randomUUID()}`,
              severity: "error",
              kind: "toolchain_failure",
              message: `Setup check ${name} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
              suggestedAction: "Verify the check command is available and correct in the checkout directory.",
              createdAt: new Date(),
            },
          };
        }
      }

      for (const name of input.setupProfile.environment.requiredEnv) {
        if (!process.env[name]) {
          return {
            ready: false,
            reason: `required environment variable ${name} is missing`,
            issue: {
              id: `env-issue-${randomUUID()}`,
              severity: "error",
              kind: "missing_env",
              message: `Required environment variable ${name} is not set.`,
              requiredEnv: [name],
              suggestedAction: `Set ${name} in the host environment or mark it as explicitly missing.`,
              createdAt: new Date(),
            },
          };
        }
      }

      for (const service of input.setupProfile.environment.requiredServices) {
        const [host, portStr] = service.split(":");
        const port = Number.parseInt(portStr ?? "", 10);
        if (!host || Number.isNaN(port)) {
          return {
            ready: false,
            reason: `required service ${service} has invalid format`,
            issue: {
              id: `env-issue-${randomUUID()}`,
              severity: "error",
              kind: "blocked_network",
              message: `Required service ${service} is not in host:port format.`,
              suggestedAction: "Use host:port format for required services.",
              createdAt: new Date(),
              ...(host ? { blockedHost: host } : {}),
              ...(Number.isNaN(port) ? {} : { blockedPort: port }),
            },
          };
        }
        const reachable = this.serviceReachability[service] ?? true;
        if (!reachable) {
          return {
            ready: false,
            reason: `required service ${service} is unreachable`,
            issue: {
              id: `env-issue-${randomUUID()}`,
              severity: "error",
              kind: "blocked_network",
              message: `Required service ${service} is unreachable.`,
              blockedHost: host,
              blockedPort: port,
              suggestedAction: "Verify the service is running and reachable from the host.",
              createdAt: new Date(),
            },
          };
        }
      }
    }

    if (!this.sidecarInfo.executable) {
      return {
        ready: false,
        reason: "AgentOS sidecar is not executable",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "sidecar_not_executable",
          message: `Sidecar at ${this.sidecarInfo.path} is not executable.`,
          createdAt: new Date(),
        },
      };
    }

    if (this.sidecarInfo.arch !== "arm64") {
      return {
        ready: false,
        reason: "AgentOS sidecar architecture mismatch",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "sidecar_arch_mismatch",
          message: `Sidecar architecture ${this.sidecarInfo.arch} does not match arm64.`,
          createdAt: new Date(),
        },
      };
    }

    if (!this.credentialsAvailable) {
      return {
        ready: false,
        reason: "model credentials are not available",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "credentials_missing",
          message: `No credentials available for model ${input.model}.`,
          createdAt: new Date(),
        },
      };
    }

    if (!this.mcpConfigValid) {
      return {
        ready: false,
        reason: "MCP config is not parseable",
        issue: {
          id: `env-issue-${randomUUID()}`,
          severity: "error",
          kind: "mcp_config_unparseable",
          message: "MCP config is not valid JSON.",
          createdAt: new Date(),
        },
      };
    }

    await this.logResourceSample("start", input.instanceId);

    const paths = workspacePaths(input.task.workspacePath);
    return {
      ready: true,
      workspacePath: input.task.workspacePath,
      checkoutPath,
      env: workspaceEnv(input.task.workspacePath),
      homePath: paths.home,
      npmPrefixPath: paths.npmPrefix,
    };
  }

  async getResourceSnapshot(): Promise<ResourceSnapshot> {
    return { ...this.resourceSnapshot };
  }

  async logResourceSample(tag: "start" | "end", instanceId: string): Promise<void> {
    const snapshot = await this.getResourceSnapshot();
    this.resourceSamples.push({ tag, instanceId, snapshot });
    this.logger.log("info", `resource-sample:${tag}`, {
      instanceId,
      rss: snapshot.rssBytes,
      freeMemoryMb: snapshot.freeMemoryMb,
      loadAverage: snapshot.loadAverage,
      workspaceSizeBytes: snapshot.workspaceSizeBytes,
      sidecarCount: snapshot.sidecarCount,
      activeVmCount: snapshot.activeVmCount,
    });
  }

  async reportIssue(issue: EnvironmentIssue): Promise<void> {
    this.issues.push({ ...issue });
    await this.issueStore?.insert(issue);
  }
}

export function createDefaultMachineEnvironment(
  config: AppConfig,
  mcpConfigProvider?: McpConfigProvider,
  deps?: DefaultMachineEnvironmentDependencies,
): MachineEnvironment {
  const defaultDeps: DefaultMachineEnvironmentDependencies = {
    bootstrapper: {
      bootstrap: async (task, mode) =>
        bootstrapWorkspace(task, config.GITHUB_TOKEN, mode),
    },
    installRunner: {
      run: async (workspacePath, checkoutPath, installCommand) =>
        runSetupInstall(
          workspacePath,
          checkoutPath,
          installCommand,
          config.GITHUB_TOKEN,
        ),
    },
    skillsInstallRunner: {
      run: async (workspacePath, checkoutPath, skillLinks) =>
        runSetupSkillsInstall(
          workspacePath,
          checkoutPath,
          skillLinks,
          config.GITHUB_TOKEN,
        ),
    },
  };
  if (mcpConfigProvider) {
    defaultDeps.mcpConfigProvider = mcpConfigProvider;
  }
  return new DefaultMachineEnvironment(config, { ...defaultDeps, ...deps });
}
