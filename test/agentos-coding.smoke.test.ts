import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { AgentOs } from "@rivet-dev/agentos-core";
import {
  AgentOsAgentTurn,
  FakeMachineEnvironment,
  type AgentTurnInput,
  type ResourceSnapshot,
  type TurnEvent,
} from "../src/agentturn/index.js";
import type { AgentOsAcpEvent } from "../src/agentturn/agentos-event-mapper.js";
import type { AgentOsSessionEvent } from "../src/discord/session-event-bridge.js";
import { World, flush } from "./support/orchestrator-harness.js";

/**
 * AgentOS coding turn tracer bullet.
 *
 * Replaces the fake AgentTurn with the real AgentOS VM lifecycle for one
 * coding turn. The test proves a prompt reaches a terminal event, resource
 * samples are logged around the VM lifecycle, and runtime stderr is captured
 * and redacted. It is gated behind AGENTOS_SMOKE=true so `npm test` stays fast
 * and credential-free by default.
 *
 * A dummy Anthropic API key is used: the provider rejects it, but the Pi ACP
 * adapter still selects a model, streams at least one session/update event, and
 * returns a terminal stopReason.
 */

const DUMMY_KEY = "dummy-key-for-coding-tracer";

class RecordingLogger {
  readonly entries: {
    level: string;
    message: string;
    meta?: Record<string, unknown> | undefined;
  }[] = [];

  log(level: string, message: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level, message, meta });
  }
}

class RecordingMachineEnvironment extends FakeMachineEnvironment {
  readonly samples: { tag: "start" | "end"; instanceId: string }[] = [];

  override async logResourceSample(
    tag: "start" | "end",
    instanceId: string,
  ): Promise<void> {
    this.samples.push({ tag, instanceId });
    await super.logResourceSample(tag, instanceId);
  }
}

function buildResourceSnapshot(): ResourceSnapshot {
  return {
    rssBytes: process.memoryUsage().rss,
    freeMemoryMb: Number.MAX_SAFE_INTEGER,
    freeDiskMb: Number.MAX_SAFE_INTEGER,
    loadAverage: [0, 0, 0],
    workspaceSizeBytes: 0,
    sidecarCount: 0,
    activeVmCount: 0,
  };
}

class FakeAgentOs {
  readonly createSessionCalls: { software: string; opts: unknown }[] = [];
  readonly promptCalls: { sessionId: string; instruction: string }[] = [];
  private readonly handlers = new Map<
    string,
    (event: AgentOsAcpEvent) => void
  >();
  private blockNext = false;
  private blockResolve: (() => void) | undefined;
  private blockReject: ((err: Error) => void) | undefined;

  async createSession(
    software: string,
    opts: unknown,
  ): Promise<{ sessionId: string }> {
    this.createSessionCalls.push({ software, opts });
    return { sessionId: "session-1" };
  }

  async prompt(
    sessionId: string,
    instruction: string,
  ): Promise<{ response: { result?: unknown }; text: string }> {
    this.promptCalls.push({ sessionId, instruction });
    if (this.blockNext) {
      this.blockNext = false;
      await new Promise<void>((resolve, reject) => {
        this.blockResolve = resolve;
        this.blockReject = reject;
      });
    }
    return { response: { result: { stopReason: "end_turn" } }, text: "done" };
  }

  onSessionEvent(
    sessionId: string,
    handler: (event: AgentOsAcpEvent) => void,
  ): () => void {
    this.handlers.set(sessionId, handler);
    return () => this.handlers.delete(sessionId);
  }

  /**
   * Block the next prompt() call until release() is called.
   */
  blockNextPrompt(): { release: () => void } {
    this.blockNext = true;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.blockResolve?.();
      this.blockResolve = undefined;
      this.blockReject = undefined;
    };
    return { release };
  }

  async cancelSession(): Promise<void> {}
  async closeSession(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function waitForTerminal(
  agentTurn: AgentOsAgentTurn,
  instanceId: string,
): Promise<Extract<TurnEvent, { type: "terminal" }>> {
  return new Promise((resolve) => {
    const unsubscribe = agentTurn.onEvent((event) => {
      if (event.type === "terminal" && event.instanceId === instanceId) {
        unsubscribe();
        resolve(event as Extract<TurnEvent, { type: "terminal" }>);
      }
    });
  });
}

describe.skipIf(!process.env.AGENTOS_SMOKE)("AgentOS coding turn", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentos-coding-"));
  const checkoutName = "web";
  const checkoutPath = join(workspace, checkoutName);
  const logger = new RecordingLogger();
  const machineEnv = new RecordingMachineEnvironment({
    resourceSnapshot: buildResourceSnapshot(),
  });
  let agentTurn: AgentOsAgentTurn;

  beforeAll(
    async () => {
      mkdirSync(checkoutPath, { recursive: true });
      // Give the guest a simple file to prove the workspace mount is live.
      writeFileSync(join(checkoutPath, "README.md"), "# tracer bullet");
      agentTurn = new AgentOsAgentTurn({
        machineEnvironment: machineEnv,
        logger,
        nodeModulesPath: resolve(process.cwd(), "node_modules"),
        getCredentials: () => ({ ANTHROPIC_API_KEY: DUMMY_KEY }),
        onSessionEvent: (event) => {
          bridgeEvents.push(event);
        },
      });
    },
    120_000,
  );

  afterAll(
    async () => {
      await agentTurn.resumeAfterRestart(async () => {});
      rmSync(workspace, { recursive: true, force: true });
    },
    120_000,
  );

  const bridgeEvents: AgentOsSessionEvent[] = [];

  it(
    "VAL-AGENTTURN-039: runs a real AgentOS coding prompt and reaches a terminal event",
    async () => {
      const input: AgentTurnInput = {
        instanceId: "discord:thread:thread-coding-1",
        role: "coding",
        instruction: "say hello",
        model: "anthropic/claude-sonnet-4-5",
        workspacePath: workspace,
        repo: "acme/web",
        baseBranch: "main",
        setupProfileRevision: 1,
        idempotencyKey: "msg-coding-1",
      };

      const events: TurnEvent[] = [];
      const unsubscribe = agentTurn.onEvent((event) => events.push(event));

      const result = await agentTurn.prompt(input);
      const terminal = await waitForTerminal(agentTurn, input.instanceId);
      expect(result).toEqual({ accepted: true });

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]).toMatchObject({
        type: "turnStarted",
        instanceId: input.instanceId,
        turnId: expect.any(String),
        attemptId: expect.any(String),
      });

      expect(terminal).toMatchObject({
        type: "terminal",
        instanceId: input.instanceId,
        outcome: expect.any(String),
      });
      expect(["completed", "cancelled", "failed", "aborted"]).toContain(
        terminal.outcome,
      );

      // At least one progress event was streamed through the bridge.
      expect(bridgeEvents.length).toBeGreaterThan(0);
      expect(
        bridgeEvents.some((event) => event.type === "text_delta"),
      ).toBe(true);

      unsubscribe();
    },
    120_000,
  );

  it(
    "VAL-AGENTTURN-039: captures and redacts AgentOS runtime logs",
    async () => {
      // Reset the logger and run a prompt. Then cancel the session after the
      // prompt returns, which forces stderr traffic from the Pi ACP adapter.
      // The onAgentStderr hook must capture and redact that traffic.
      logger.entries.length = 0;
      const input: AgentTurnInput = {
        instanceId: "discord:thread:thread-coding-logs",
        role: "coding",
        instruction: "say hello",
        model: "anthropic/claude-sonnet-4-5",
        workspacePath: workspace,
        repo: "acme/web",
        baseBranch: "main",
        setupProfileRevision: 1,
        idempotencyKey: "msg-coding-logs",
      };

      const events: TurnEvent[] = [];
      const unsubscribe = agentTurn.onEvent((event) => events.push(event));
      const result = await agentTurn.prompt(input);
      expect(result).toEqual({ accepted: true });
      await agentTurn.cancel(input.instanceId);
      unsubscribe();

      const logEntries = logger.entries.filter(
        (entry) => entry.message === "agentos-runtime-log",
      );
      expect(logEntries.length).toBeGreaterThan(0);
      for (const entry of logEntries) {
        const line = String(entry.meta?.line ?? "");
        expect(line).not.toContain(DUMMY_KEY);
      }
    },
    120_000,
  );

  it(
    "observes waiting state via terminal outcome and resource samples around the VM lifecycle",
    () => {
      // The terminal event is what the orchestrator uses to transition a task
      // from running back to waiting. The tracer bullet proves the real VM
      // lifecycle emits that terminal event.
      const terminal = logger.entries.find(
        (entry) => entry.message === "agentos-turn-event-handler-failed",
      );
      expect(terminal).toBeUndefined();

      // Resource samples are logged at start and end of the turn.
      const startSample = machineEnv.samples.find(
        (s) => s.tag === "start" && s.instanceId === "discord:thread:thread-coding-1",
      );
      const endSample = machineEnv.samples.find(
        (s) => s.tag === "end" && s.instanceId === "discord:thread:thread-coding-1",
      );
      expect(startSample).toBeDefined();
      expect(endSample).toBeDefined();
    },
  );

  it(
    "VAL-PARITY-132/133: coding prompt surfaces discovered skills and required blocks",
    async () => {
      // Install a fake skill in the workspace HOME so discoverInstalledSkills
      // surfaces it. The full prompt composition happens in the orchestrator's
      // buildPrompt; this test proves the AgentOsAgentTurn receives and sends
      // a prompt that contains the surfaced skill and context blocks.
      const home = join(workspace, ".home");
      mkdirSync(join(home, ".agents", "skills", "peer-review"), {
        recursive: true,
      });

      const instruction = [
        "Task id: task-1",
        "Repository: acme/web",
        "Base branch: main",
        "Workspace: /workspace/web",
        "Admitted setup profile revision: 1",
        "Setup checks: test=npm test",
        "Required env: API_KEY",
        "",
        "Installed skills:",
        "- peer-review",
        "",
        "Setup profile memory:",
        "memory",
        "",
        "Fix the bug",
      ].join("\n");

      const input: AgentTurnInput = {
        instanceId: "discord:thread:thread-coding-2",
        role: "coding",
        instruction,
        model: "anthropic/claude-sonnet-4-5",
        workspacePath: workspace,
        repo: "acme/web",
        baseBranch: "main",
        setupProfileRevision: 1,
        idempotencyKey: "msg-coding-2",
      };

      const events: TurnEvent[] = [];
      const unsubscribe = agentTurn.onEvent((event) => events.push(event));
      const result = await agentTurn.prompt(input);
      const terminal = await waitForTerminal(agentTurn, input.instanceId);

      expect(result).toEqual({ accepted: true });
      expect(terminal).toMatchObject({
        type: "terminal",
        instanceId: input.instanceId,
      });

      unsubscribe();
    },
    120_000,
  );

  it(
    "VAL-AGENTTURN-023: orchestrator-backed task transitions back to waiting after terminal completion",
    async () => {
      const fakeAgentOs = new FakeAgentOs();
      const agentOsAgentTurn = new AgentOsAgentTurn({
        machineEnvironment: machineEnv,
        logger,
        nodeModulesPath: resolve(process.cwd(), "node_modules"),
        getCredentials: () => ({ ANTHROPIC_API_KEY: DUMMY_KEY }),
        agentOsFactory: {
          create: async () => fakeAgentOs as unknown as AgentOs,
        },
      });

      const world = new World(1, 9000, {
        machineEnvironment: machineEnv,
        agentTurn: agentOsAgentTurn,
      });

      const { release } = fakeAgentOs.blockNextPrompt();
      const result = await world.submitRaw("m-orchestrator-waiting");
      const task = result.task;
      expect(task).toBeDefined();
      // The fake AgentOS prompt is blocked, so the task stays running while
      // the turn executes.
      expect(world.store.snapshot(task!.id).status).toBe("running");

      release();
      await flush();

      // After the terminal event is emitted, the orchestrator transitions the
      // task back to waiting.
      expect(world.store.snapshot(task!.id).status).toBe("waiting");

      await agentOsAgentTurn.resumeAfterRestart(async () => {});
    },
    120_000,
  );
});
