import { Octokit } from "@octokit/rest";
import { verifySetupEnvironment } from "../setup/verify.js";
import type { AgentTurnInput } from "../agentturn/types.js";
import type { BindingsHost, GitExecutor, OctokitFactory, ResolvedInstance } from "./types.js";

export interface BindingsHostDependencies {
  githubToken: string;
  discordUserId: string;
  postMessage: (threadId: string, content: string) => Promise<void>;
  editMessage: (threadId: string, messageId: string, content: string) => Promise<void>;
  environmentIssueStore: BindingsHost["environmentIssueStore"];
  setupStore: BindingsHost["setupStore"];
  taskStore: BindingsHost["taskStore"];
  gitExecutor: GitExecutor;
  octokitFactory?: OctokitFactory;
  verifySetupEnvironment?: BindingsHost["verifySetupEnvironment"];
}

export async function createBindingsHost(
  input: AgentTurnInput,
  deps: BindingsHostDependencies,
): Promise<BindingsHost> {
  const resolved = await resolveInstance(input, deps);
  return {
    instanceResolver: {
      resolve: async () => resolved,
    },
    githubToken: deps.githubToken,
    discordUserId: deps.discordUserId,
    postMessage: deps.postMessage,
    editMessage: deps.editMessage,
    environmentIssueStore: deps.environmentIssueStore,
    setupStore: deps.setupStore,
    taskStore: deps.taskStore,
    gitExecutor: deps.gitExecutor,
    octokitFactory:
      deps.octokitFactory ??
      ((token: string) =>
        new Octokit({
          auth: token,
          userAgent: "threadcord/0.1.0",
        }) as any),
    verifySetupEnvironment: deps.verifySetupEnvironment ?? verifySetupEnvironment,
  };
}

async function resolveInstance(
  input: AgentTurnInput,
  deps: BindingsHostDependencies,
): Promise<ResolvedInstance> {
  if (input.instanceId.startsWith("setup:")) {
    const runId = input.instanceId.slice(6);
    const run = await deps.setupStore.getRunByInstanceId(input.instanceId);
    return {
      instanceId: input.instanceId,
      threadId: run?.discordThreadId ?? runId,
      workspacePath: run?.workspacePath ?? input.workspacePath,
      repo: run?.repo ?? input.repo,
      branch: run?.branch ?? input.baseBranch,
      setupRunId: runId,
      progressMessageId: run?.progressMessageIds?.[0],
    };
  }

  const threadId = input.instanceId.startsWith("discord:thread:")
    ? input.instanceId.slice(15)
    : input.instanceId;
  const task = await deps.taskStore.getByInstanceId(input.instanceId);
  return {
    instanceId: input.instanceId,
    threadId,
    workspacePath: input.workspacePath,
    repo: input.repo,
    branch: input.baseBranch,
    taskId: task?.id,
    progressMessageId: task?.progressMessageIds?.[0] ?? task?.statusMessageId,
  };
}

