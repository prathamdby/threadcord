import { spawn } from "node:child_process";
import { redact } from "../util/redact.js";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export async function execa(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer =
      options.timeout !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeout)
        : undefined;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            redact(
              `${command} ${args.join(" ")} timed out after ${options.timeout}ms`,
            ),
          ),
        );
        return;
      }
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            redact(
              `${command} ${args.join(" ")} failed with exit ${code}: ${stderr || stdout}`,
            ),
          ),
        );
      }
    });
  });
}
