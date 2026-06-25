import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { setPendingUserTurnMessage } from "./user-turn-message.js";

export function createPostThreadMessageTool(instanceId: string) {
  return defineTool({
    name: "post_thread_message",
    description:
      "Queue a short final message for the human operator in Discord. Call once near the end of a successful turn with a plain-language summary meant for the user (not internal notes). It is delivered after the turn-completed notice.",
    parameters: v.object({
      message: v.pipe(v.string(), v.minLength(1), v.maxLength(1900)),
    }),
    async execute(input) {
      setPendingUserTurnMessage(instanceId, input.message);
      return "Message queued for Discord.";
    },
  });
}