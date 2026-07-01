import type { SetupRun } from "./profile.js";

/** Fields needed to stream AgentOS session events into a Discord setup thread. */
export interface SetupProgressSession {
  id: string;
  discordThreadId: string;
  progressMessageIds: string[];
}

export function setupProgressSessionFromRun(
  run: SetupRun,
): SetupProgressSession | undefined {
  if (!run.discordThreadId || !run.progressMessageIds?.length) return undefined;
  return {
    id: run.id,
    discordThreadId: run.discordThreadId,
    progressMessageIds: run.progressMessageIds,
  };
}
