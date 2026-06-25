import { redact } from "../util/redact.js";
import type { DiscordPublisher } from "./publisher.js";
import { PROGRESS_ROLL_THRESHOLD } from "./limits.js";

export interface ProgressStreamTarget {
  threadId: string;
  progressMessageIds: string[];
}

export interface ProgressStreamStore {
  appendProgressMessageId(id: string, messageId: string): Promise<void>;
}

export interface InstanceRenderState {
  lines: string[];
  lastLine: string | undefined;
  lastRenderedBase: string | undefined;
  repeatCount: number;
  lastWasTerminalBlock: boolean;
  bubbleStartIndex: number;
  currentBubbleCharCount: number;
}

export function newInstanceRenderState(): InstanceRenderState {
  return {
    lines: [],
    lastLine: undefined,
    lastRenderedBase: undefined,
    repeatCount: 0,
    lastWasTerminalBlock: false,
    bubbleStartIndex: 0,
    currentBubbleCharCount: 0,
  };
}

type AppendOutcome = { kind: "repeat" } | { kind: "new"; line: string };

export function appendRenderedLine(
  inst: InstanceRenderState,
  baseLine: string,
  terminal: boolean,
): AppendOutcome {
  if (inst.lastLine !== undefined && baseLine === inst.lastLine) {
    inst.repeatCount += 1;
    const base = inst.lastRenderedBase ?? baseLine;
    const prev = inst.lines[inst.lines.length - 1]!;
    const next = `${base} (×${inst.repeatCount})`;
    inst.lines[inst.lines.length - 1] = next;
    inst.currentBubbleCharCount += next.length - prev.length;
    inst.lastWasTerminalBlock = terminal;
    return { kind: "repeat" };
  }
  let line = baseLine;
  if (terminal && inst.lastWasTerminalBlock) {
    line = baseLine.slice(baseLine.indexOf("\n") + 1);
  }
  inst.lines.push(line);
  inst.lastLine = baseLine;
  inst.lastRenderedBase = line;
  inst.repeatCount = 1;
  inst.lastWasTerminalBlock = terminal;
  return { kind: "new", line };
}

export function shouldRollBubble(
  currentBubbleCharCount: number,
  nextLineLength: number,
  threshold: number = PROGRESS_ROLL_THRESHOLD,
): boolean {
  return (
    currentBubbleCharCount > 0 &&
    currentBubbleCharCount + 1 + nextLineLength > threshold
  );
}

export async function maybeRollProgressMessage(
  streamId: string,
  inst: InstanceRenderState,
  newLine: string,
  target: ProgressStreamTarget | undefined,
  store: ProgressStreamStore | undefined,
  publisher: DiscordPublisher,
): Promise<void> {
  if (!shouldRollBubble(inst.currentBubbleCharCount, newLine.length)) {
    const wasEmpty = inst.currentBubbleCharCount === 0;
    inst.currentBubbleCharCount += (wasEmpty ? 0 : 1) + newLine.length;
    return;
  }

  const liveId = target?.progressMessageIds.at(-1);
  let rolled = false;
  if (target && liveId && store) {
    try {
      const frozenContent = inst.lines
        .slice(inst.bubbleStartIndex, inst.lines.length - 1)
        .map((line) => redact(line))
        .join("\n");
      await publisher.edit(target.threadId, liveId, frozenContent);
      const sent = await publisher.send(target.threadId, redact(newLine));
      await store.appendProgressMessageId(streamId, sent.id);
      target.progressMessageIds.push(sent.id);
      rolled = true;
    } catch (error) {
      console.error(`[threadcord] progress roll failed for ${streamId}`, error);
    }
  }

  if (rolled) {
    inst.bubbleStartIndex = inst.lines.length - 1;
    inst.currentBubbleCharCount = newLine.length;
  } else {
    inst.currentBubbleCharCount += 1 + newLine.length;
  }
}

export async function flushProgressMessage(
  target: ProgressStreamTarget | undefined,
  inst: InstanceRenderState,
  publisher: DiscordPublisher,
): Promise<void> {
  const liveId = target?.progressMessageIds.at(-1);
  if (!target || !liveId) return;
  const content = inst.lines
    .slice(inst.bubbleStartIndex)
    .map((line) => redact(line))
    .join("\n");
  await publisher.edit(target.threadId, liveId, content);
}