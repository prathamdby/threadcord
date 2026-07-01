# Threadcord Domain Context

This document defines the ubiquitous language used by the Threadcord agentOS rewrite.
It is the authoritative glossary for reviews, tests, and implementation discussions.

## Naming

- **agentOS** — the product/runtime name. Use this spelling in prose, commit messages,
  Discord copy, and docs. Not `AgentOS`, `Agent OS`, or `agentos` unless quoting an
  npm package or env var (e.g. `@rivet-dev/agentos-core`, `AGENTOS_SIDECAR_BIN`).
- **ACP** — Agent Client Protocol. Pi sessions are created via ACP `session/new` inside
  the agentOS sidecar.

## Task

A **Task** is a durable work unit admitted via the `/task create` Discord slash command.
It is persisted as a row in the `tasks` table and follows a state machine:
`queued | running | waiting | completed | failed | cancelled`.

A task is tied to a specific repo, branch, setup profile revision, and model.
It owns a private Discord thread, a workspace directory on the host, and one or more
agent turns. Tasks are queued FIFO when the concurrency slot cap is reached and are
dequeued automatically when a slot becomes free.

## Turn

A **Turn** is one execution of an agent prompt for a task or setup run. A turn starts
when AgentTurn accepts it and ends when exactly one terminal event is emitted:
`completed`, `failed`, `cancelled`, or `aborted`. A turn may be retried through multiple
attempts managed by TurnRunner; each retry produces a new `agent_turn_attempts` row but
is still the same logical turn from the operator's point of view.

## Setup Profile

A **Setup Profile** is a durable, revisioned bootstrap recipe per `repo+branch` stored
in the `setup_profiles` table. It contains:

- an `install` command run once on the first task turn for that repo+branch
- one or more `check` commands used by the environment readiness probe
- required environment variable names, required services, and required OS packages
- a memory markdown field that accumulates verified lessons per repo+branch
- a status state machine: `running | ready | failed | updating`

Tasks require a `ready` setup profile at admission time. The profile revision is pinned
on the task and remains stable for the task lifetime even if the profile is later updated.

## Agent Session

An **Agent Session** is the stable conversation context scoped to an agent instance id
(`discord:thread:<id>` for a task, or `setup:<runId>` for a setup run). It is stored in
`agent_sessions` and owns:

- ordered events in `agent_events`
- transcript state used to resume after restart
- a reference to the workspace path and the current VM/session handle

The agent session survives process restart for non-terminal tasks; the next follow-up
continues against the restored transcript and workspace state.

## AgentTurn

**AgentTurn** is the top-level facade and primary seam the orchestrators depend on.
It exposes a small interface:

- `prompt(input)` — accept or reject a turn before a slot is claimed
- `cancel(instanceId)` — cancel a running turn
- `onEvent(handler)` — subscribe to turn lifecycle events
- `resumeAfterRestart(notify)` — reconcile interrupted turns after a crash/restart

AgentTurn has a deep implementation that composes three deep modules:
TurnRunner, MachineEnvironment, and ConversationLog. For every accepted turn it emits
a `turnStarted` event, zero or more progress/tool/message events, and exactly one
terminal event.

## TurnRunner

**TurnRunner** is the deep module that owns durable turn execution. It manages:

- `agent_turn_attempts` rows with lease owner, heartbeat timestamp, timeout, and terminal status
- retry policy per failure class (provider transient, sidecar crash, host shutdown, Discord projection failure)
- idempotency keys derived from Discord message or setup command ids
- cancellation races and exactly-one terminal event durability

TurnRunner is the self-hosted replacement for the small slice of Temporal that
Threadcord needs. It does not know Discord formatting, agentOS APIs, or GitHub tools.

## MachineEnvironment

**MachineEnvironment** is the deep module that owns the agent's machine and workspace.
It is responsible for:

- workspace directory creation and read-write mount into the agentOS VM
- agentOS VM lifecycle (createSession, prompt, cancelSession, dispose)
- setup profile environment materialization (non-secret env names, install/check commands)
- resource admission (CPU, memory, active VM count, workspace disk, sidecar count)
- ARM64 compatibility checks and sidecar binary readiness
- the environment readiness probe that blocks a turn before any model spend
- an optional self-hosted sandbox fallback when agentOS alone cannot run the target repo

MachineEnvironment does not know Discord threads or queue ordering.

## ConversationLog

**ConversationLog** is the deep module that owns the canonical conversation state.
It stores append-only events in `agent_events` with:

- `seq` scoped to the agent session
- `attempt_seq` scoped to a single turn attempt
- `attempt_id` linking events to retries
- a `superseded` flag used to rewind stale output after a retry

ConversationLog provides transcript rebuild for resume and the Discord projection inputs
fed to the existing progress bridge. It does not start VMs or mutate task state.

## Relationship summary

```
Task ──► AgentSession (one per task/setup run)
  │        │
  │        ├──► AgentTurn.prompt ──► TurnRunner.startAttempt
  │        │                         MachineEnvironment.prepare
  │        │                         ConversationLog.append
  │        │
  │        └──► TurnRunner terminal event
  │                ▲
  │                └── agentOS session events ──► SessionEventBridge
  │                                                  ▼
  │                                             Discord progress bridge
  │
  └──► Setup Profile (revision pinned at admission)
```

A Task creates one AgentSession. Each turn within that session is one AgentTurn call,
durable through TurnRunner, hosted by MachineEnvironment, and logged by ConversationLog.
The Agent Session survives restarts and is rebuilt from the ConversationLog transcript.

## Provider configuration

Threadcord normalizes all model provider env (`ANTHROPIC_*`, `OPENAI_*`, `PROVIDERS` /
`PROVIDER_*`) into a single **ProviderRegistry** (`src/providers/`). Before each Pi
session, **materializePiSessionConfig** writes:

- `<checkout>/.pi/settings.json` for the task's default model
- `<workspace>/.pi/agent/models.json` when transport overrides or custom providers require it

Session API keys are resolved via **resolvePiSessionCredentials** using Pi's canonical env
var names (e.g. `OPENCODE_API_KEY` for `opencode-go`). Legacy `.pi-agent/` paths are
not used.
