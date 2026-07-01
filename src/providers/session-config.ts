import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildModelsJson } from "./models-json.js";
import { parseModelRef } from "./credentials.js";
import type {
  MaterializePiSessionConfigInput,
  MaterializePiSessionConfigResult,
} from "./types.js";

export const PI_PROJECT_DIR_NAME = ".pi";
export const PI_AGENT_DIR_NAME = ".pi/agent";
export const GUEST_PI_AGENT_DIR = "/workspace/.pi/agent";

function checkoutPathForWorkspace(
  workspacePath: string,
  repo: string,
): string {
  return join(workspacePath, basename(repo));
}

export async function materializePiSessionConfig(
  input: MaterializePiSessionConfigInput,
): Promise<MaterializePiSessionConfigResult> {
  const { provider, modelId } = parseModelRef(input.model);
  const checkoutPath = checkoutPathForWorkspace(
    input.workspacePath,
    input.repo,
  );
  const projectPiDir = join(checkoutPath, PI_PROJECT_DIR_NAME);
  await mkdir(projectPiDir, { recursive: true });

  await writeFile(
    join(projectPiDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: provider,
        defaultModel: modelId,
      },
      null,
      2,
    )}\n`,
  );

  const modelsJson = buildModelsJson(input.registry);
  if (!modelsJson) {
    return { wroteModelsJson: false };
  }

  const agentDir = join(input.workspacePath, PI_AGENT_DIR_NAME);
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(modelsJson, null, 2)}\n`,
  );

  return {
    agentDir: GUEST_PI_AGENT_DIR,
    wroteModelsJson: true,
  };
}
