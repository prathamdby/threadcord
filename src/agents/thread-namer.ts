import { createAgent } from "@flue/runtime";
import { getRuntimeConfig } from "../config.js";
import { composePrompt } from "./prompts/compose.js";

export interface ThreadNamerInput {
  instruction: string;
}

export default createAgent<ThreadNamerInput>(async ({ payload }) => ({
  model: getRuntimeConfig().defaultModel,
  durability: { timeoutMs: 90_000, maxAttempts: 2 },
  instructions: composePrompt({
    role: "thread-namer",
    ctx: {
      instruction: payload?.instruction ?? "",
    },
  }),
  tools: [],
}));
