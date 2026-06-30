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
      post_thread_message: createPostThreadMessageTool(host),
      post_thread_report: createPostThreadReportTool(host),
      edit_thread_message: createEditThreadMessageTool(host),
      create_github_pull_request: createGitHubPullRequestTool(host),
      git_push: createGitPushTool(host),
      append_threadcord_setup_memory: createAppendSetupMemoryTool(host),
      record_setup_memory: createRecordSetupMemoryTool(host),
      report_environment_issue: createReportEnvironmentIssueTool(host),
      request_missing_secret: createRequestMissingSecretTool(host),
      request_network_access: createRequestNetworkAccessTool(host),
    },
  });
}

export function createSetupToolKit(host: BindingsHost): ToolKit {
  return toolKit({
    name: "threadcord-setup",
    description:
      "Threadcord setup bindings: profile promotion, draft proposals, setup memory append, and environment issue reporting.",
    tools: {
      save_threadcord_setup_profile: createSaveThreadcordSetupProfileTool(host),
      propose_setup_profile_change: createProposeSetupProfileChangeTool(host),
      append_threadcord_setup_memory: createAppendSetupMemoryTool(host),
      record_setup_memory: createRecordSetupMemoryTool(host),
      report_environment_issue: createReportEnvironmentIssueTool(host),
      request_missing_secret: createRequestMissingSecretTool(host),
      request_network_access: createRequestNetworkAccessTool(host),
    },
  });
}
