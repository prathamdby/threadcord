import { createAgent } from "@flue/runtime";
import { getRuntimeConfig } from "../config.js";
import { threadNamerDurability } from "../flue/agent-guardrails.js";
import { composePrompt } from "./prompts/compose.js";

export interface ThreadNamerInput {
  instruction: string;
}

export default createAgent<ThreadNamerInput>(async ({ payload }) => ({
  model: getRuntimeConfig().defaultModel,
  durability: threadNamerDurability(getRuntimeConfig()),
  instructions: composePrompt({
    role: "thread-namer",
    ctx: {
      instruction: payload?.instruction ?? "",
    },
  }),
  tools: [],
}));