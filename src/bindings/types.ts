import type { z } from "zod";
import type { HostTool } from "@rivet-dev/agentos-core";
import type { EnvironmentIssue, EnvironmentIssueStore } from "../agentturn/machine-environment.js";
import type { SetupEnvironment, SetupProfile } from "../setup/profile.js";
import type { SetupStore } from "../setup/store.js";
import type { TaskStore } from "../task/store.js";
import type { VerifySetupEnvironmentInput, SetupVerifyResult } from "../setup/verify.js";

export type { HostTool };

export interface ResolvedInstance {
  instanceId: string;
  threadId: string;
  workspacePath: string;
  repo: string;
  branch: string;
  taskId?: string | undefined;
  setupRunId?: string | undefined;
  progressMessageId?: string | undefined;
}

export interface InstanceResolver {
  resolve(instanceId: string): Promise<ResolvedInstance | undefined>;
}

export interface GitExecutor {
  run(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface OctokitLike {
  rest: {
    pulls: {
      create(input: { owner: string; repo: string; title: string; head: string; base: string; body?: string }): Promise<{
        data: { number: number; html_url: string; state: string };
      }>;
    };
  };
}

export interface OctokitFactory {
  (token: string): OctokitLike;
}

export interface BindingsHost {
  instanceResolver: InstanceResolver;
  githubToken: string;
  discordUserId: string;
  postMessage: (threadId: string, content: string) => Promise<void>;
  editMessage: (threadId: string, messageId: string, content: string) => Promise<void>;
  environmentIssueStore: EnvironmentIssueStore;
  setupStore: Pick<
    SetupStore,
    | "appendReadyProfileMemory"
    | "promoteRun"
    | "failRun"
    | "getRunByInstanceId"
    | "getProfileById"
    | "createDraft"
    | "updateDraft"
  >;
  taskStore: Pick<TaskStore, "getByInstanceId">;
  gitExecutor: GitExecutor;
  octokitFactory: OctokitFactory;
  verifySetupEnvironment: (input: VerifySetupEnvironmentInput) => Promise<SetupVerifyResult>;
}

export type SetupStoreEnvironment = SetupEnvironment;

export interface ToolResult {
  ok: true;
  value: unknown;
}

export interface ToolError {
  ok: false;
  error: string;
}

export type ToolOutput = ToolResult | ToolError;

export function toolResult(value: unknown): ToolResult {
  return { ok: true, value };
}

export function toolError(error: string): ToolError {
  return { ok: false, error };
}

export type ZodSchema = z.ZodTypeAny;
