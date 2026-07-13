import {
  APPROACH_CODING,
  DEFAULT_CODING,
  END_TURN_CHECKLIST,
  GIT_WORKFLOW,
  IDENTITY_CODING,
  IDENTITY_SETUP,
  INVESTIGATION_MODE,
  NEVER_CODING,
  NEVER_SETUP,
  READ_BEFORE_EDIT,
  REFUSE,
  SECRECY,
  SECRECY_SETUP,
  SECRETS_CODING,
  SECRETS_SETUP,
  SETUP_MEMORY_LEARNING,
  SETUP_OUTPUT,
  SETUP_TOOL_ARGUMENTS,
  SKILL_TOOL,
  REPO_MAP_TOOL,
  SETUP_SAVE_CONTRACT,
  SETUP_SCOPE,
  SHELL,
  SHELL_SETUP,
  STATUS_POSTING,
  THREAD_NAME_CONTRACT,
  TOOL_ARGUMENTS,
  TOOL_USE,
  USER_INSTRUCTION_BOUNDARY,
  WHEN_DONE_SETUP,
  WORKSPACE,
  WRITING,
  WRITING_SETUP,
} from "./prompt-blocks.js";

export type AgentRole = "coding" | "setup" | "thread-namer";

export interface CodingCtx {
  cwd: string;
  repo: string;
  baseBranch: string;
  pushOverride?: string;
  checks: Record<string, string>;
  requiredEnv: string[];
  instruction: string;
}

export interface SetupCtx {
  repo: string;
  branch: string;
  instruction?: string;
}

export interface ThreadNamerCtx {
  instruction: string;
}

export type ComposeInput =
  | { role: "coding"; ctx: CodingCtx }
  | { role: "setup"; ctx: SetupCtx }
  | { role: "thread-namer"; ctx: ThreadNamerCtx };

function formatChecksList(checks?: Record<string, string> | null): string {
  const entries = Object.entries(checks ?? {});
  if (entries.length === 0) {
    return "   (none configured)";
  }
  return entries.map(([name, cmd]) => `   - ${name}: \`${cmd}\``).join("\n");
}

function formatRequiredEnvList(requiredEnv?: string[] | null): string {
  if (!requiredEnv || requiredEnv.length === 0) {
    return "(none)";
  }
  return requiredEnv.join(", ");
}

export function composePrompt(input: ComposeInput): string {
  switch (input.role) {
    case "coding": {
      const { ctx } = input;
      const checksBlock = formatChecksList(ctx.checks);
      const requiredEnvBlock = formatRequiredEnvList(ctx.requiredEnv);
      return [
        IDENTITY_CODING,
        WORKSPACE(ctx.cwd, ctx.repo, ctx.baseBranch),
        APPROACH_CODING,
        SECRETS_CODING,
        REFUSE,
        SECRECY,
        TOOL_ARGUMENTS,
        TOOL_USE,
        READ_BEFORE_EDIT,
        SHELL,
        GIT_WORKFLOW,
        END_TURN_CHECKLIST(ctx.baseBranch, checksBlock, requiredEnvBlock),
        STATUS_POSTING,
        WRITING,
        INVESTIGATION_MODE,
        SETUP_MEMORY_LEARNING,
        SKILL_TOOL,
        REPO_MAP_TOOL,
        DEFAULT_CODING,
        NEVER_CODING,
        USER_INSTRUCTION_BOUNDARY,
        "INSTRUCTION",
        ctx.instruction,
      ].join("\n\n");
    }
    case "setup": {
      const { ctx } = input;
      return [
        IDENTITY_SETUP(ctx.repo, ctx.branch),
        SETUP_SCOPE,
        SETUP_OUTPUT,
        SETUP_TOOL_ARGUMENTS,
        SETUP_SAVE_CONTRACT,
        SECRETS_SETUP,
        SECRECY_SETUP,
        SHELL_SETUP,
        WRITING,
        WRITING_SETUP,
        NEVER_SETUP,
        WHEN_DONE_SETUP,
        ...(ctx.instruction ? ["INSTRUCTION", ctx.instruction] : []),
      ].join("\n\n");
    }
    case "thread-namer": {
      const { ctx } = input;
      return [WRITING, THREAD_NAME_CONTRACT, "INPUT", ctx.instruction].join(
        "\n\n",
      );
    }
    default: {
      const _exhaustive: never = input;
      throw new Error(`Unhandled agent role: ${String(_exhaustive)}`);
    }
  }
}
