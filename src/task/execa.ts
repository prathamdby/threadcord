import { spawn } from 'node:child_process';
import { redact } from '../util/redact.js';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function execa(command: string, args: string[], options: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(redact(`${command} ${args.join(' ')} failed with exit ${code}: ${stderr || stdout}`)));
      }
    });
  });
}
