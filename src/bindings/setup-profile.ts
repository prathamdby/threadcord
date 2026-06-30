import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { hostTool } from "@rivet-dev/agentos-core";
import {
  SETUP_MEMORY_APPEND_MAX_CHARS,
  SETUP_MEMORY_MAX_CHARS,
  type SetupProfile,
  validateSetupMemoryAppend,
  validateSetupProfilePayload,
} from "../setup/profile.js";
import { formatSetupVerifyError } from "../setup/verify.js";
import type { BindingsHost, HostTool, ToolOutput } from "./types.js";
import { toolResult, toolError } from "./types.js";

const SetupEnvironmentSchema = z.object({
  install: z.string().min(1),
  start: z.string().optional(),
  checks: z.record(z.string(), z.string().min(1)).optional(),
  requiredEnv: z.array(z.string()).optional(),
  requiredServices: z.array(z.string()).optional(),
  requiredPackages: z.array(z.string().min(1)).optional(),
  armCaveats: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  requiresNativeExecution: z.boolean().optional(),
});

const SetupEnvironmentPatchSchema = z.object({
  install: z.string().min(1).optional(),
  start: z.string().optional(),
  checks: z.record(z.string(), z.string().min(1)).optional(),
  requiredEnv: z.array(z.string()).optional(),
  requiredServices: z.array(z.string()).optional(),
  requiredPackages: z.array(z.string().min(1)).optional(),
  armCaveats: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  requiresNativeExecution: z.boolean().optional(),
});

const SaveSetupProfileInputSchema = z.object({
  instanceId: z.string().min(1),
  environment: SetupEnvironmentSchema,
  memoryMarkdown: z.string().min(1).max(SETUP_MEMORY_MAX_CHARS),
});

const ProposeSetupProfileChangeInputSchema = z.object({
  instanceId: z.string().min(1),
  environmentPatch: SetupEnvironmentPatchSchema.optional(),
  memoryMarkdown: z.string().min(1).max(SETUP_MEMORY_MAX_CHARS).optional(),
  reason: z.string().min(1).optional(),
});

const RecordSetupMemoryInputSchema = z.object({
  instanceId: z.string().min(1),
  markdown: z.string().min(1).max(SETUP_MEMORY_APPEND_MAX_CHARS),
  evidence: z.string().max(SETUP_MEMORY_APPEND_MAX_CHARS).optional(),
});

export const SAVE_THREADCORD_SETUP_PROFILE_DESCRIPTION =
  "Promote the setup workspace to a durable Threadcord setup profile. Re-runs install, checks, skills, and start smoke. Only passed checks are saved. Returns profile id and revision.";

export const PROPOSE_SETUP_PROFILE_CHANGE_DESCRIPTION =
  "Propose a setup profile change. Creates a draft from the current profile with the patch and memory update, posts a Discord milestone, and does not modify the live profile.";

export const RECORD_SETUP_MEMORY_DESCRIPTION =
  "Record a durable setup memory note for this repo/branch, with optional evidence. Use for self-healing discoveries worth preserving. <=4000 chars, no secrets.";

export function createSaveThreadcordSetupProfileTool(
  host: BindingsHost,
): HostTool<z.infer<typeof SaveSetupProfileInputSchema>, ToolOutput> {
  return hostTool({
    description: SAVE_THREADCORD_SETUP_PROFILE_DESCRIPTION,
    inputSchema: SaveSetupProfileInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved?.setupRunId) {
        return toolError(`Unknown setup instance: ${input.instanceId}`);
      }

      const validated = validateSetupProfilePayload({
        environment: input.environment,
        memoryMarkdown: input.memoryMarkdown,
      });
      if (!validated.ok) {
        return toolError(validated.message);
      }

      const run = await host.setupStore.getRunByInstanceId(resolved.instanceId);
      if (!run) {
        return toolError("Setup run is missing.");
      }

      const profileBefore = await host.setupStore.getProfileById(run.profileId);
      const environment = { ...validated.value.environment };
      if (
        profileBefore?.environment.skills?.length &&
        !environment.skills?.length
      ) {
        environment.skills = profileBefore.environment.skills;
      }

      const checkoutDir = join(run.workspacePath, basename(run.repo));
      const verification = await host.verifySetupEnvironment({
        environment,
        workspaceRoot: run.workspacePath,
        checkoutDir,
        githubToken: host.githubToken,
      });
      if (!verification.ok) {
        return toolError(formatSetupVerifyError(verification));
      }

      const profile = await host.setupStore.promoteRun({
        runId: run.id,
        environment,
        memoryMarkdown: validated.value.memoryMarkdown,
      });

      await rm(run.workspacePath, { recursive: true, force: true }).catch(
        (error) => {
          console.warn(
            `[threadcord] Failed to remove setup workspace ${run.workspacePath}`,
            error,
          );
        },
      );

      return toolResult({
        status: "saved",
        profileId: profile.id,
        revision: profile.revision,
      });
    },
  });
}

export function createProposeSetupProfileChangeTool(
  host: BindingsHost,
): HostTool<z.infer<typeof ProposeSetupProfileChangeInputSchema>, ToolOutput> {
  return hostTool({
    description: PROPOSE_SETUP_PROFILE_CHANGE_DESCRIPTION,
    inputSchema: ProposeSetupProfileChangeInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }

      let profile: SetupProfile | undefined;
      if (resolved.setupRunId) {
        const run = await host.setupStore.getRunByInstanceId(
          resolved.instanceId,
        );
        if (!run) {
          return toolError("Setup run is missing.");
        }
        profile = await host.setupStore.getProfileById(run.profileId);
      } else {
        profile = await host.setupStore.getProfile(
          resolved.repo,
          resolved.branch,
        );
      }
      if (!profile) {
        return toolError("Setup profile is missing.");
      }

      const environment = {
        ...profile.environment,
        ...input.environmentPatch,
        ...(input.environmentPatch?.checks
          ? { checks: input.environmentPatch.checks }
          : {}),
        ...(input.environmentPatch?.requiredEnv
          ? { requiredEnv: input.environmentPatch.requiredEnv }
          : {}),
        ...(input.environmentPatch?.requiredServices
          ? { requiredServices: input.environmentPatch.requiredServices }
          : {}),
        ...(input.environmentPatch?.requiredPackages
          ? { requiredPackages: input.environmentPatch.requiredPackages }
          : {}),
        ...(input.environmentPatch?.armCaveats
          ? { armCaveats: input.environmentPatch.armCaveats }
          : {}),
        ...(input.environmentPatch?.skills
          ? { skills: input.environmentPatch.skills }
          : {}),
        ...(input.environmentPatch?.requiresNativeExecution !== undefined
          ? {
              requiresNativeExecution:
                input.environmentPatch.requiresNativeExecution,
            }
          : {}),
      };
      const memoryMarkdown = input.memoryMarkdown ?? profile.memoryMarkdown;

      const validated = validateSetupProfilePayload({
        environment,
        memoryMarkdown,
      });
      if (!validated.ok) {
        return toolError(validated.message);
      }

      const draft = await host.setupStore.createDraft(
        profile.id,
        host.discordUserId,
      );
      const updated = await host.setupStore.updateDraft({
        draftId: draft.id,
        environment: validated.value.environment,
        memoryMarkdown: validated.value.memoryMarkdown,
        validationStatus: "valid",
        validationMessage: input.reason
          ? `Proposed: ${input.reason}`
          : "Proposed by setup agent.",
      });

      await host.postMessage(
        resolved.threadId,
        `**Setup profile change proposed** (draft \`${updated.id}\`)${
          input.reason ? `: ${input.reason}` : "."
        }\nUse \`/setup edit\` to review and apply.`,
      );

      return toolResult({
        draftId: updated.id,
        baseRevision: updated.baseRevision,
      });
    },
  });
}

export function createRecordSetupMemoryTool(
  host: BindingsHost,
): HostTool<z.infer<typeof RecordSetupMemoryInputSchema>, ToolOutput> {
  return hostTool({
    description: RECORD_SETUP_MEMORY_DESCRIPTION,
    inputSchema: RecordSetupMemoryInputSchema,
    async execute(input): Promise<ToolOutput> {
      const resolved = await host.instanceResolver.resolve(input.instanceId);
      if (!resolved) {
        return toolError(`Unknown instance: ${input.instanceId}`);
      }

      const block = input.evidence
        ? `${input.markdown.trim()}\n\n*Evidence:* ${input.evidence.trim()}`
        : input.markdown;

      const validation = validateSetupMemoryAppend(block);
      if (!validation.ok) {
        return toolError(validation.message);
      }

      const result = await host.setupStore.appendReadyProfileMemory({
        repo: resolved.repo,
        branch: resolved.branch,
        appendMarkdown: validation.value,
      });
      if (!result.ok) {
        return toolError(result.message);
      }

      return toolResult({
        status: "recorded",
        revision: result.profile.revision,
      });
    },
  });
}

