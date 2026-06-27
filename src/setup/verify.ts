import { spawn } from "node:child_process";
import { execa } from "../task/execa.js";
import { resolveGithubHttpsGitEnv } from "../task/git-auth.js";
import { wrapWorkspaceBashCommand } from "../task/workspace-env.js";
import { redact } from "../util/redact.js";
import type { SetupEnvironment } from "./profile.js";
import { buildSkillsInstallShellCommand } from "./skills.js";

export interface SetupCommandFailure {
  name: string;
  command: string;
  output: string;
}

export type SetupVerifyResult =
  { ok: true } | { ok: false; failures: SetupCommandFailure[] };

export interface VerifySetupEnvironmentInput {
  environment: SetupEnvironment;
  workspaceRoot: string;
  checkoutDir: string;
  githubToken: string;
  installTimeoutMs?: number;
  checkTimeoutMs?: number;
  startProbeMs?: number;
}

const DEFAULT_INSTALL_TIMEOUT_MS = 1_800_000;
const DEFAULT_CHECK_TIMEOUT_MS = 300_000;
const DEFAULT_START_PROBE_MS = 10_000;
const OUTPUT_MAX_CHARS = 2000;
const START_KILL_GRACE_MS = 500;

function isProbeKillExit(code: number | null): boolean {
  return code === null || code === 0 || code === 143 || code === 137;
}

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

function formatFailureOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  return truncateTail(redact(combined), OUTPUT_MAX_CHARS);
}

async function runCommand(input: {
  name: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<SetupCommandFailure | undefined> {
  try {
    await execa("bash", ["-c", wrapWorkspaceBashCommand(input.command)], {
      cwd: input.cwd,
      env: input.env,
      timeout: input.timeoutMs,
    });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: input.name,
      command: redact(input.command),
      output: truncateTail(redact(message), OUTPUT_MAX_CHARS),
    };
  }
}

async function probeStartCommand(input: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  probeMs: number;
}): Promise<SetupCommandFailure | undefined> {
  return new Promise((resolve) => {
    const child = spawn(
      "bash",
      ["-c", wrapWorkspaceBashCommand(input.command)],
      {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedByProbe = false;
    let killTimer: NodeJS.Timeout | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const finish = (failure: SetupCommandFailure | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(probeTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(failure);
    };

    const killChild = () => {
      if (child.killed || child.exitCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGKILL");
        }
      }, START_KILL_GRACE_MS);
    };

    child.on("error", (error) => {
      killChild();
      finish({
        name: "start",
        command: redact(input.command),
        output: formatFailureOutput(stdout, error.message),
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      if (killedByProbe) {
        if (isProbeKillExit(code)) {
          finish(undefined);
          return;
        }
        finish({
          name: "start",
          command: redact(input.command),
          output: formatFailureOutput(stdout, stderr),
        });
        return;
      }
      if (code === 0) {
        finish(undefined);
        return;
      }
      finish({
        name: "start",
        command: redact(input.command),
        output: formatFailureOutput(stdout, stderr),
      });
    });

    const probeTimer = setTimeout(() => {
      killedByProbe = true;
      killChild();
    }, input.probeMs);
  });
}

export async function verifySetupEnvironment(
  input: VerifySetupEnvironmentInput,
): Promise<SetupVerifyResult> {
  const env = await resolveGithubHttpsGitEnv(
    input.workspaceRoot,
    input.githubToken,
  );
  const installTimeoutMs = input.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const checkTimeoutMs = input.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const startProbeMs = input.startProbeMs ?? DEFAULT_START_PROBE_MS;
  const failures: SetupCommandFailure[] = [];

  const installFailure = await runCommand({
    name: "install",
    command: input.environment.install,
    cwd: input.checkoutDir,
    env,
    timeoutMs: installTimeoutMs,
  });
  if (installFailure) {
    failures.push(installFailure);
    return { ok: false, failures };
  }

  const skillLinks = input.environment.skills ?? [];
  if (skillLinks.length > 0) {
    const skillsCommand = buildSkillsInstallShellCommand(skillLinks);
    const skillsFailure = await runCommand({
      name: "skills",
      command: skillsCommand,
      cwd: input.checkoutDir,
      env,
      timeoutMs: installTimeoutMs,
    });
    if (skillsFailure) {
      failures.push(skillsFailure);
      return { ok: false, failures };
    }
  }

  const checks = Object.entries(input.environment.checks).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [checkName, checkCommand] of checks) {
    const checkFailure = await runCommand({
      name: `check:${checkName}`,
      command: checkCommand,
      cwd: input.checkoutDir,
      env,
      timeoutMs: checkTimeoutMs,
    });
    if (checkFailure) {
      failures.push(checkFailure);
    }
  }
  if (failures.length > 0) {
    return { ok: false, failures };
  }

  const startCommand = input.environment.start.trim();
  if (startCommand) {
    const startFailure = await probeStartCommand({
      command: startCommand,
      cwd: input.checkoutDir,
      env,
      probeMs: startProbeMs,
    });
    if (startFailure) {
      failures.push(startFailure);
      return { ok: false, failures };
    }
  }

  return { ok: true };
}

export function formatSetupVerifyError(
  result: Extract<SetupVerifyResult, { ok: false }>,
  maxChars = 3500,
): string {
  const header = "Setup verification failed.";
  const lines = [header];
  let remaining = maxChars - header.length - 1;

  for (const failure of result.failures) {
    const prefix = `${failure.name}: ${failure.command}\n`;
    const budget = Math.max(0, remaining - prefix.length);
    const output =
      budget <= 0
        ? ""
        : failure.output.length <= budget
          ? failure.output
          : failure.output.slice(-budget);
    const block = `${prefix}${output}`;
    lines.push(block);
    remaining -= block.length + 1;
    if (remaining <= 0) break;
  }

  return lines.join("\n");
}
