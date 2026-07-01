import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SidecarInfo, SidecarResolver } from "./machine-environment.js";

const require = createRequire(import.meta.url);
const { getSidecarPath } = require("@rivet-dev/agentos-sidecar") as {
  getSidecarPath: () => string;
};

export interface SidecarProbeResult {
  ok: boolean;
  path: string;
  executable: boolean;
  arch: string;
  version?: string | undefined;
  error?: string | undefined;
}

function isSupportedHostArch(): boolean {
  const { platform, arch } = process;
  if (platform === "linux" || platform === "darwin") {
    return arch === "arm64" || arch === "x64";
  }
  return false;
}

export function resolveSidecarPath(): string {
  const override = process.env.AGENTOS_SIDECAR_BIN;
  if (override) return override;
  return getSidecarPath();
}

export async function getSidecarInfo(): Promise<SidecarInfo> {
  const path = resolveSidecarPath();
  try {
    await fs.access(path, constants.X_OK);
    return { path, executable: true, arch: process.arch };
  } catch {
    return { path, executable: false, arch: process.arch };
  }
}

export async function probeSidecar(): Promise<SidecarProbeResult> {
  if (!isSupportedHostArch()) {
    return {
      ok: false,
      path: "",
      executable: false,
      arch: `${process.platform}/${process.arch}`,
      error: `unsupported host architecture: ${process.platform}/${process.arch}`,
    };
  }

  let path: string;
  try {
    path = resolveSidecarPath();
  } catch (error) {
    return {
      ok: false,
      path: "",
      executable: false,
      arch: process.arch,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let executable = false;
  try {
    await fs.access(path, constants.X_OK);
    executable = true;
  } catch {
    executable = false;
  }

  let arch = process.arch;
  let version: string | undefined;
  let error: string | undefined;

  if (executable) {
    try {
      const fileOutput = await execFilePromise("file", [path]);
      const lowered = fileOutput.toLowerCase();
      if (lowered.includes("aarch64") || lowered.includes("arm64")) {
        arch = "arm64";
      } else if (lowered.includes("x86-64") || lowered.includes("x86_64")) {
        arch = "x64";
      }
      version = fileOutput.trim();
    } catch (probeError) {
      error =
        probeError instanceof Error
          ? probeError.message
          : String(probeError);
    }
  }

  const ok = executable && arch === "arm64";
  return { ok, path, executable, arch, version, error };
}

export function createSidecarResolver(): SidecarResolver {
  return {
    resolve: async () => getSidecarInfo(),
  };
}

function execFilePromise(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10000 }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export function sidecarModulePath(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return join(process.cwd(), "src", "agentturn");
  }
}
