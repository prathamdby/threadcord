import type { FlueEvent } from "@flue/runtime";
import { observe } from "@flue/runtime";
import { isThreadcordInstance } from "../ids.js";
import type { TaskStore } from "../task/store.js";
import { redact } from "../util/redact.js";
import type { DiscordPublisher } from "./publisher.js";

export function registerObserveBridge(args: {
  store: TaskStore;
  publisher: DiscordPublisher;
  onAgentEnd: (instanceId: string) => Promise<void>;
}): void {
  const buffers = new Map<string, string[]>();
  const timers = new Map<string, NodeJS.Timeout>();

  observe((event) => {
    const instanceId = "instanceId" in event ? event.instanceId : undefined;
    if (!instanceId) return;
    const isSetupInstance = instanceId.startsWith("setup:");
    const isTaskInstance = isThreadcordInstance(instanceId);
    if (event.type === "agent_end" && (isTaskInstance || isSetupInstance)) {
      void args.onAgentEnd(instanceId);
    }
    if (!isTaskInstance) return;
    const line = eventSummary(event);
    if (!line) return;

    const current = buffers.get(instanceId) ?? [];
    current.push(line);
    buffers.set(instanceId, current.slice(-8));

    const existing = timers.get(instanceId);
    if (existing) clearTimeout(existing);
    timers.set(
      instanceId,
      setTimeout(() => {
        timers.delete(instanceId);
        void flush(instanceId, buffers.get(instanceId) ?? [], args);
      }, 2500),
    );

  });
}

async function flush(
  instanceId: string,
  lines: string[],
  args: { store: TaskStore; publisher: DiscordPublisher },
): Promise<void> {
  const task = await args.store.getByInstanceId(instanceId);
  if (!task?.statusMessageId) return;
  await args.publisher.edit(
    task.discordThreadId,
    task.statusMessageId,
    `Status\n${lines.map((line) => `- ${redact(line)}`).join("\n")}`,
  );
}

function eventSummary(event: FlueEvent): string | undefined {
  switch (event.type) {
    case "agent_start":
      return "Agent started";
    case "turn_start":
      return `Model turn started (${event.purpose})`;
    case "tool_start":
      return `Tool started: ${event.toolName}`;
    case "tool":
      return `Tool finished: ${event.toolName}`;
    case "agent_end":
      return "Agent turn completed";
    case "log":
      return `${event.level}: ${event.message}`;
    default:
      return undefined;
  }
}
