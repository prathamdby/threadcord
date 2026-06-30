import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface FallbackCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FallbackExecutor {
  run(
    command: string,
    cwd: string,
    options?: { timeoutMs?: number },
  ): Promise<FallbackCommandResult>;
}

export interface HostCommandFallbackExecutorOptions {
  /** Commands that may be executed. Exact-match only. */
  allowlist: string[];
  /** Default timeout when the caller does not specify one. */
  defaultTimeoutMs: number;
  /** Maximum bytes of stdout/stderr to capture. */
  maxOutputBytes?: number;
  /** Environment variable names that must never be forwarded to commands. */
  blockedEnv?: string[];
}

/**
 * Self-hosted host-command fallback. Commands are executed in a host child
 * process with a strict allowlist, a bounded timeout, and no secrets in the
 * command environment. This is the lightweight alternative to a sandboxed
 * container fallback.
 */
export class HostCommandFallbackExecutor implements FallbackExecutor {
  private readonly allowlist: Set<string>;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly blockedEnv: Set<string>;

  constructor(options: HostCommandFallbackExecutorOptions) {
    this.allowlist = new Set(options.allowlist);
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.maxOutputBytes = options.maxOutputBytes ?? 65_536;
    this.blockedEnv = new Set(options.blockedEnv ?? HOST_BLOCKED_ENV);
  }

  async run(
    command: string,
    cwd: string,
    options?: { timeoutMs?: number },
  ): Promise<FallbackCommandResult> {
    if (!this.allowlist.has(command)) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: `Command is not on the fallback allowlist: "${command}"`,
      };
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const env = buildCommandEnv(this.blockedEnv);

    return runChildProcess("bash", ["-c", command], cwd, env, timeoutMs, this.maxOutputBytes);
  }
}

export const HOST_BLOCKED_ENV = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DISCORD_BOT_TOKEN",
  "THREADCORD_HTTP_BEARER",
  "DATABASE_URL",
];

export interface DockerContainerSpec {
  image: string;
  /** Host path that is bind-mounted into the container. */
  hostWorkspacePath: string;
  /** Path inside the container where the workspace is mounted. */
  guestWorkspacePath: string;
  /** Always false for the preferred local-container fallback. */
  mountDockerSocket: false;
}

export interface DockerContainer {
  containerId: string;
  spec: DockerContainerSpec;
}

export interface DockerClient {
  createContainer(spec: DockerContainerSpec): Promise<DockerContainer>;
  runCommand(
    container: DockerContainer,
    input: {
      command: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
    },
  ): Promise<FallbackCommandResult>;
  removeContainer(container: DockerContainer): Promise<void>;
}

export interface DockerContainerFallbackExecutorOptions {
  docker: DockerClient;
  spec: DockerContainerSpec;
  allowlist: string[];
  defaultTimeoutMs: number;
  maxOutputBytes?: number;
  blockedEnv?: string[];
}

/**
 * Self-hosted Docker container fallback. Commands are executed inside a local
 * Docker container with the workspace bind-mounted read-write. The container
 * never mounts the host Docker socket by default; it is a local sandbox backed
 * by a separate container image, not a privileged socket mount.
 */
export class DockerContainerFallbackExecutor implements FallbackExecutor {
  private readonly docker: DockerClient;
  private readonly spec: DockerContainerSpec;
  private readonly allowlist: Set<string>;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly blockedEnv: Set<string>;

  constructor(options: DockerContainerFallbackExecutorOptions) {
    this.docker = options.docker;
    this.spec = options.spec;
    this.allowlist = new Set(options.allowlist);
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.maxOutputBytes = options.maxOutputBytes ?? 65_536;
    this.blockedEnv = new Set(options.blockedEnv ?? HOST_BLOCKED_ENV);
  }

  async run(
    command: string,
    cwd: string,
    options?: { timeoutMs?: number },
  ): Promise<FallbackCommandResult> {
    if (!this.allowlist.has(command)) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: `Command is not on the fallback allowlist: "${command}"`,
      };
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const env = buildCommandEnv(this.blockedEnv);
    const container = await this.docker.createContainer(this.spec);
    try {
      return await withTimeout(
        this.docker.runCommand(container, {
          command,
          cwd,
          env,
          timeoutMs,
        }),
        timeoutMs,
      );
    } finally {
      await this.docker.removeContainer(container).catch(() => {});
    }
  }
}

function buildCommandEnv(blockedEnv: Set<string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !blockedEnv.has(key)) {
      env[key] = value;
    }
  }
  // Ensure PATH is present even if the host happens to block it (it should not).
  if (!env.PATH) {
    env.PATH = "/usr/local/bin:/usr/bin:/bin";
  }
  return env;
}

function runChildProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<FallbackCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout = truncateOutput(stdout + chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = truncateOutput(stderr + chunk, maxOutputBytes);
    });

    const finish = (result: FallbackCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      if (child.killed || child.exitCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000);
      finish({
        exitCode: 124,
        stdout,
        stderr: `Fallback command timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on("error", (error) => {
      finish({
        exitCode: 127,
        stdout,
        stderr: error.message,
      });
    });

    child.on("close", (exitCode) => {
      finish({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function withTimeout(
  promise: Promise<FallbackCommandResult>,
  timeoutMs: number,
): Promise<FallbackCommandResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        exitCode: 124,
        stdout: "",
        stderr: `Fallback command timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        resolve({
          exitCode: 127,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

function truncateOutput(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  const prefix = text.slice(0, maxBytes - 24);
  return `${prefix}...[truncated]`;
}

export interface DockerCliClientOptions {
  image: string;
  hostWorkspacePath: string;
  guestWorkspacePath: string;
  maxOutputBytes?: number;
}

/**
 * Real Docker CLI client. Each command runs in a fresh, short-lived container
 * (`docker run --rm`) with the workspace bind-mounted. No Docker socket is
 * mounted into the container.
 */
export function createDockerCliClient(
  options: DockerCliClientOptions,
): DockerClient {
  const spec: DockerContainerSpec = {
    image: options.image,
    hostWorkspacePath: options.hostWorkspacePath,
    guestWorkspacePath: options.guestWorkspacePath,
    mountDockerSocket: false,
  };
  return {
    createContainer: async () => ({
      containerId: `docker-run-${randomUUID()}`,
      spec,
    }),
    runCommand: async (container, input) => {
      const { command, cwd, env, timeoutMs } = input;
      const maxOutputBytes = options.maxOutputBytes ?? 65_536;
      const guestCwd = cwd.replace(
        spec.hostWorkspacePath,
        spec.guestWorkspacePath,
      );
      const envArgs = Object.entries(env).flatMap(([key, value]) => [
        "-e",
        `${key}=${value ?? ""}`,
      ]);
      const args = [
        "run",
        "--rm",
        "-v",
        `${spec.hostWorkspacePath}:${spec.guestWorkspacePath}`,
        "-w",
        guestCwd,
        ...envArgs,
        spec.image,
        "bash",
        "-c",
        command,
      ];
      return runChildProcess(
        "docker",
        args,
        process.cwd(),
        process.env,
        timeoutMs,
        maxOutputBytes,
      );
    },
    removeContainer: async () => {},
  };
}
