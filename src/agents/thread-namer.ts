import { createAgent } from "@flue/runtime";
import { appConfigFromAgentEnv } from "./helpers/app-config-env.js";
import { threadNamerDurability } from "../flue/agent-guardrails.js";
import { composePrompt } from "./prompts/compose.js";

export interface ThreadNamerInput {
  instruction: string;
}

export default createAgent<ThreadNamerInput>(async ({ env, payload }) => {
  const appConfig = appConfigFromAgentEnv(env);
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