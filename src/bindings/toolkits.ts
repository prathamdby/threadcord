import { toolKit } from "@rivet-dev/agentos-core";
import type { ToolKit } from "@rivet-dev/agentos-core";
import type { BindingsHost } from "./types.js";
import {
  createPostThreadMessageTool,
  createPostThreadReportTool,
} from "./discord-post.js";
import { createEditThreadMessageTool } from "./discord-edit.js";
import { createGitHubPullRequestTool } from "./github.js";
import { createGitPushTool } from "./git-push.js";
import { createAppendSetupMemoryTool } from "./setup-memory.js";
import { createRecordSetupMemoryTool } from "./setup-profile.js";
import {
  createReportEnvironmentIssueTool,
  createRequestMissingSecretTool,
  createRequestNetworkAccessTool,
} from "./environment.js";
import {
  createProposeSetupProfileChangeTool,
  createSaveThreadcordSetupProfileTool,
} from "./setup-profile.js";

export function createCodingToolKit(host: BindingsHost): ToolKit {
  return toolKit({
    name: "threadcord-coding",
    description:
      "Threadcord coding task bindings: Discord post/edit, GitHub PR, git push, setup memory append, and environment issue reporting.",
    tools: {
      "post-thread-message": createPostThreadMessageTool(host),
      "post-thread-report": createPostThreadReportTool(host),
      "edit-thread-message": createEditThreadMessageTool(host),
      "create-github-pull-request": createGitHubPullRequestTool(host),
      "git-push": createGitPushTool(host),
      "append-threadcord-setup-memory": createAppendSetupMemoryTool(host),
      "record-setup-memory": createRecordSetupMemoryTool(host),
      "propose-setup-profile-change": createProposeSetupProfileChangeTool(host),
      "report-environment-issue": createReportEnvironmentIssueTool(host),
      "request-missing-secret": createRequestMissingSecretTool(host),
      "request-network-access": createRequestNetworkAccessTool(host),
    },
  });
}

export function createSetupToolKit(host: BindingsHost): ToolKit {
  return toolKit({
    name: "threadcord-setup",
    description:
      "Threadcord setup bindings: profile promotion, draft proposals, setup memory append, and environment issue reporting.",
    tools: {
      "save-threadcord-setup-profile": createSaveThreadcordSetupProfileTool(host),
      "propose-setup-profile-change": createProposeSetupProfileChangeTool(host),
      "append-threadcord-setup-memory": createAppendSetupMemoryTool(host),
      "record-setup-memory": createRecordSetupMemoryTool(host),
      "report-environment-issue": createReportEnvironmentIssueTool(host),
      "request-missing-secret": createRequestMissingSecretTool(host),
      "request-network-access": createRequestNetworkAccessTool(host),
    },
  });
}
