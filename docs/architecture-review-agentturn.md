# Architecture Review — AgentTurn Facade Gate

**Status:** Completed  
**Scope:** Milestone 2 (AgentTurn Core) entry gate  
**Author:** runtime-worker — arch-review-gate  
**Goal:** Analyze the codebase for deepening opportunities aligned with the AgentTurn facade and execute the top recommendation before the AgentTurn facade slice begins.

---

## 1. Summary

This review examined the Threadcord runtime from a deep-module perspective after the foundation spikes proved AgentOS is viable on darwin-arm64. The top deepening opportunity is the same one identified in `architecture.md`: the orchestrators still import and call `dispatch` directly from `@flue/runtime`, and abort calls reach into `src/flue/agent-work-abort.ts`. These call sites are shallow coupling points. Consolidating them behind a single `AgentTurn` seam increases leverage, locality, and testability before the next slice builds the fake facade.

**Top recommendation (executed in this gate):** Introduce the `AgentTurn` interface and a transitional `FlueAgentTurn` adapter, then refactor `TaskOrchestrator` and `SetupOrchestrator` to inject `AgentTurn` instead of calling `dispatch` directly. This keeps Flue fully operational in production while making the orchestrator depend only on the new seam, so the next slice can drop in a fake `AgentTurn` without touching the orchestrators again.

---

## 2. Deepening analysis

### 2.1 Current seam state

The runtime has three active execution paths that touch Flue:

| Path | Current seam | Flue import | Depth problem |
|---|---|---|---|
| Task turn dispatch | `TaskOrchestrator` → `dispatch` (`@flue/runtime`) | `src/task/orchestrator.ts` | Orchestrator knows the agent software, dispatch protocol, and `DispatchAgentInput` shape. |
| Setup turn dispatch | `SetupOrchestrator` → `dispatch` (`@flue/runtime`) | `src/setup/orchestrator.ts` | Same as above; also hard-codes `setup:<runId>` instance id format inside dispatch. |
| Abort in-flight work | `stopTaskWork` → `abortAgentWorkForInstance` (`src/flue/agent-work-abort.ts`) | `src/task/abort-thread-task.ts` | Abort plumbing leaks Flue internal execution-store knowledge into the task lifecycle. |
| Thread rename | `scheduleReadableThreadRename` → `dispatch` + `observe` | `src/task/rename-thread.ts` | Out-of-band Flue dispatch outside the turn lifecycle; will be handled by the thread-namer feature later. |

The `registerObserveBridge` call in `src/app.ts` is also a Flue event sink, but it is a *bridge* concern, not an orchestrator concern. The SessionEventBridge feature (slice 6) will replace it, so this gate does not move it.

### 2.2 Shallow vs deep opportunities

The obvious horizontal alternative is to keep the current `DispatchTurn` function seam and add more injectable strategies as migration proceeds. That would expand the orchestrator's interface surface with Flue-specific concepts (`DispatchAgentInput`, `abortAgentWorkForInstance`) and make the fake harder to write. It is shallow.

The deep alternative is to make the orchestrator depend on a single, role-based seam: `AgentTurn`. The interface hides the agent software, the dispatch protocol, the abort bridge, and the event source. Complexity moves into the adapter, where it is localized. The orchestrator gets leverage because it can drive coding, setup, and (later) thread-naming turns through one interface.

### 2.3 Why this is the top recommendation

- It aligns exactly with the architecture document's AgentTurn composition seam.
- It unblocks the next slice (`agentturn-facade`) to implement a fake without editing the orchestrators.
- It is the smallest change that materially deepens the module graph: the orchestrators lose their `@flue/runtime` import for dispatch, and Flue-specific dispatch logic is isolated in one adapter.
- It passes the deletion test: deleting `AgentTurn` (and its adapters) would force all Flue dispatch knowledge back into the orchestrators, making the runtime non-functional for its intended rewrite path.

---

## 3. Executed changes

1. **`src/agentturn/types.ts`** — defined the `AgentTurn` interface and the supporting types (`AgentTurnRole`, `AgentTurnInput`, `TurnEvent`, `TerminalOutcome`).
2. **`src/agentturn/flue-adapter.ts`** — implemented `FlueAgentTurn`, a transitional adapter that:
   - Maps `AgentTurnInput` to the current `DispatchAgentInput` for coding turns and to the setup agent payload for setup turns.
   - Calls `dispatch` from `@flue/runtime` internally.
   - Implements `cancel` via `abortAgentWorkForInstance` so the orchestrator no longer imports `src/flue/agent-work-abort.ts`.
   - Stubs `onEvent` and `resumeAfterRestart` for the transitional phase; the observe-bridge and orchestrator restart logic remain in place until the dedicated slices replace them.
3. **`src/task/orchestrator.ts`** — refactored to accept `AgentTurn` as an injected dependency, build `AgentTurnInput`, and call `agentTurn.prompt`. The abort path now delegates to `agentTurn.cancel`.
4. **`src/setup/orchestrator.ts`** — refactored to accept `AgentTurn` and dispatch setup turns through the same seam.
5. **`src/app.ts`** — constructs a single `FlueAgentTurn` and injects it into both orchestrators.
6. **`test/support/orchestrator-harness.ts`** — kept the existing `dispatch` override for backward compatibility, wrapping it in a minimal `AgentTurn` before passing it to the orchestrator.

No `AgentOS` production code is introduced. Flue remains the default production path and remains present and green.

---

## 4. Remaining deepening work (next slices)

- **AgentTurn facade + fake** (`agentturn-facade`): build the fake `AgentTurn` that records prompts and emits terminal events manually; prove the waiting-task follow-up tracer bullet.
- **TurnRunner contract** (`turnrunner-contract`): move durable attempts, leases, heartbeats, and retries behind `AgentTurn`.
- **ConversationLog + SessionEventBridge** (`convlog-bridge`): replace the global `observe` bridge with `AgentTurn.onEvent` and a SessionEventBridge adapter.
- **MachineEnvironment contract** (`machineenv-contract`): move workspace, VM, and resource admission behind `AgentTurn`.
- **Thread namer** (`thread-namer`): move the remaining `dispatch`/`observe` in `src/task/rename-thread.ts` behind the `AgentTurn` seam with role `thread-namer`.

---

## 5. Verification

- `npm run check` — typecheck clean.
- `npm test` — all existing tests pass (Flue remains present and green).
- No new behavior is asserted by this gate; the gate's success criteria are the documented review and the executed consolidation.
