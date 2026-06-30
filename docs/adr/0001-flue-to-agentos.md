# ADR 0001: Replace Flue with AgentOS behind the AgentTurn facade

**Status:** Accepted

**Date:** 2026-06-30

**Decision makers:** Threadcord maintainer

## Context

Threadcord currently depends on the Flue agent framework for every coding and setup turn:
dispatch, observe streaming, tool definitions, MCP wiring, and Postgres-backed Flue session tables.
Flue is beta, couples the product to a narrow runtime model, and spreads agent-runtime concerns
across shallow glue modules that are hard to test in isolation.

AgentOS (`@rivet-dev/agentos-core`) provides an in-process WASM/V8-isolate VM kernel with a
high-level `AgentOs` class, native sidecar binaries, and an ACP agent ecosystem. The Pi agent
(`@agentos-software/pi`) is the hardened ACP coding agent available today. AgentOS lets Threadcord
replace Flue dispatch/observe with a small `prompt`/`onEvent` facade while keeping the rest of the
product unchanged.

The rewrite is performed in place in the existing repository. Flue remains present and working until
the final removal slice, and all existing tests must pass after each migration slice.

## Decision

We will replace the Flue agent runtime with AgentOS behind a new deep **AgentTurn** module.

- AgentTurn is the single seam the orchestrators depend on. Its implementation composes three deep
  modules: **TurnRunner** (durable execution), **MachineEnvironment** (workspace/VM/resources), and
  **ConversationLog** (append-only event log + Discord projection).
- A **SessionEventBridge** adapter maps AgentOS session events to the existing Discord progress bridge
  so that debouncing, tool formatting, milestone detection, and redaction remain unchanged.
- Flue tools (`defineTool` + valibot) become AgentOS bindings/toolkits with Zod-validated inputs.
- Host bindings enforce credential safety: the GitHub PAT never enters the AgentOS guest environment,
  guest files, Discord output, or transcript persistence.

## Consequences

### Production target: OCI Ampere AArch64

The production target is an OCI Ampere AArch64 VPS (4 vCPU / 24 GB RAM, Docker Compose, `linux/arm64`).
This is not an optional deployment target; it is the production target. Every dependency, sidecar binary,
native package, and Docker decision must work on `linux/arm64` without QEMU emulation. The AgentOS
sidecar and Pi agent packages are pinned to exact versions to control pre-1.0 churn.

### Self-host-only constraint

Threadcord remains a single-operator, self-hosted product. The rewrite does not introduce managed
Temporal, managed queues, managed sandbox providers (E2B, Daytona, Vercel, Cloudflare), hosted worker
fleets, or cloud object storage dependencies. Durable state stays in Postgres and named Docker volumes;
Docker Compose remains the only required process manager.

### Environment-fidelity constraint

The development environment is the product. AgentOS-only execution is not automatically accepted as a
full environment. Before the first coding turn, MachineEnvironment must run a readiness probe that checks
workspace writability, repo checkout, setup profile install/check commands, required secrets, required
services, MCP config, sidecar readiness, and ARM64 compatibility. If the probe fails, the task is blocked
with a specific environment issue rather than burning a model turn. A self-hosted sandbox or host-command
fallback may be used when AgentOS alone cannot satisfy the target repo's dev environment, but it must be
strictly allowlisted, timed, and never expose host secrets to the guest.

### Positive consequences

- A single, well-defined seam at AgentTurn makes the runtime replaceable and testable with fakes.
- Durable execution in Postgres prevents a process crash from leaving a slot permanently occupied.
- Conversation state is decoupled from VM state, so a VM can die while the transcript and task state survive.
- The existing Discord UX, commands, queue behavior, setup flows, and MCP management remain unchanged at the operator level.

### Negative consequences

- AgentOS is pre-1.0 with heavy API churn; versions must be pinned and bumps must be verified upstream.
- Pi is the only hardened ACP coding agent today; Claude and OpenCode are deferred until marked available.
- Environment fidelity must be proven per setup profile; native dependency failures are classified as environment blockers, not code bugs.
- Resource-aware admission is required because the 4c/24GB ARM host cannot naively run the same number of heavy coding agents as the old Flue-era concurrency cap assumed.
