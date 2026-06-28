import { createAgent } from "@flue/runtime";
import { getAgentAppConfig } from "./helpers/app-config.js";
import { threadNamerDurability } from "../flue/agent-guardrails.js";
import { composePrompt } from "./prompts/compose.js";

export interface ThreadNamerInput {
  instruction: string;
}

export default createAgent<ThreadNamerInput>(async ({ payload }) => {
  const appConfig = getAgentAppConfig();
  return {
    model: appConfig.defaultModel,
    durability: threadNamerDurability(appConfig),
    instructions: composePrompt({
      role: "thread-namer",
      ctx: {
        instruction: payload?.instruction ?? "",
      },
    }),
    tools: [],
  };
});