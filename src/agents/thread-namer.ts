import { createAgent } from "@flue/runtime";
import { getRuntimeConfig } from "../config.js";

export interface ThreadNamerInput {
  instruction: string;
}

export default createAgent<ThreadNamerInput>(async ({ payload }) => ({
  model: getRuntimeConfig().defaultModel,
  durability: { timeoutMs: 90_000, maxAttempts: 2 },
  instructions: [
    "You name Discord threads for coding tasks.",
    "Read the task instruction below.",
    "Reply with one concise thread title only: no quotes, no markdown, no preamble, no explanation.",
    "Use at most 80 characters. Prefer short verb-led phrases.",
    payload?.instruction ?? "",
  ]
    .filter(Boolean)
    .join("\n"),
  tools: [],
}));