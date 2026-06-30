# Environment Fidelity Spike Report

**Feature:** `env-fidelity-spike` (Foundation milestone)  
**Date:** 2026-06-30  
**Host:** macOS darwin-arm64, Node v24.16.0  
**AgentOS versions:** `@rivet-dev/agentos-core@0.2.4`, `@rivet-dev/agentos-sidecar@0.2.4`, `@agentos-software/pi@0.2.1`, `@mariozechner/pi-coding-agent@0.73.1`

## Summary

The environment fidelity spike ran a representative Node.js repo through its setup profile `install` and `check` commands inside the same AgentOS VM execution environment the agent will use. The spike found that **AgentOS cannot run `npm install` on this darwin-arm64 host** because the in-VM `npm` toolchain is missing an internal module (`/__secure_exec/node-runtime/npm/lib/utils/display.js`). The spike proved that a **self-hosted host-command fallback** runs the same install and check commands successfully in the same workspace directory, and it classified the failure as a typed environment blocker (`missing_package`) rather than a code bug.

## Representative target repo

A minimal Node project created in a temporary workspace:

```json
{
  "name": "env-fidelity-repo",
  "version": "1.0.0",
  "scripts": {
    "check": "node -e \"require('is-odd'); console.log('check passed')\""
  },
  "dependencies": {
    "is-odd": "^3.0.1"
  }
}
```

- **Install command:** `npm install`
- **Check command:** `npm run check`

The repo is representative of a Threadcord setup profile: it has a dependency installation step and a verification step that proves the dependency is usable.

## Method

The spike is implemented as a vitest smoke test gated by `AGENTOS_SMOKE=true`:

- `test/env-fidelity-spike.smoke.test.ts` — creates an AgentOS VM, mounts the workspace read-write, and tries each command with `agentOs.exec()`.
- `test/env-fidelity-classification.test.ts` — unit tests for the environment-issue classifier (runs in default `npm test`).
- `test/support/env-fidelity-helpers.ts` — spike-only helper that models the `agent_environment_issues` schema from `architecture.md`.

If a command fails in AgentOS, the helper `classifyCommandFailure()` maps it to a typed environment issue, and the test immediately re-runs the same command via a host-command binding (Node `child_process.execFile` on the host, in the same workspace directory, with a timeout). This proves the fallback path without requiring production MachineEnvironment code.

## Results

### AgentOS-only execution

| Command | Result in AgentOS VM | Exit code | Failure signature |
|---|---|---|---|
| `npm install` | Failed | 1 | `Error: Cannot find module '/__secure_exec/node-runtime/npm/lib/utils/display.js'` |
| `npm run check` | Failed | 1 | Same internal npm module failure |

The failure is a **native/toolchain environment blocker**, not a bug in the target repo or the spike test. The AgentOS VM reports `node` and `npm` binaries on `PATH`, but the embedded `npm` distribution is incomplete on this darwin-arm64 preview build.

### Self-hosted fallback

| Command | Fallback result | Exit code | Evidence |
|---|---|---|---|
| `npm install` | Succeeded on host | 0 | `node_modules/is-odd` created |
| `npm run check` | Succeeded on host | 0 | stdout contains `check passed` |

The fallback uses the host Node/npm toolchain in the same workspace directory. This is the "host-command binding" fallback shape documented in the PRD; production will add strict allowlists and timeouts in MachineEnvironment.

### Environment issue classification

Both AgentOS failures were classified as:

```json
{
  "severity": "error",
  "kind": "missing_package",
  "packageName": "/__secure_exec/node-runtime/npm/lib/utils/display.js",
  "suggestedAction": "Verify ... is available in the AgentOS execution environment or enable a self-hosted fallback (host/Docker) for this setup profile."
}
```

The shape matches the `agent_environment_issues` table defined in `architecture.md`.

## Assertions satisfied

| Validation contract ID | Assertion | Status |
|---|---|---|
| VAL-FOUND-023 | Representative repo install runs in AgentOS VM or fallback proven | ✅ Pass — AgentOS failed, host fallback succeeded |
| VAL-FOUND-024 | Check commands run in the same execution environment as the agent | ✅ Pass — check attempted in AgentOS, then successfully run via fallback in the same workspace |
| VAL-FOUND-025 | Native dependency failures classified as environment blockers | ✅ Pass — failures recorded as `missing_package` environment issues, not code bugs |

## Implications for the rewrite

1. **AgentOS-only execution is insufficient for Node/npm setup profiles on darwin-arm64.** The self-hosted fallback (host-command binding or Docker sandbox) is required for environment fidelity.
2. **MachineEnvironment must implement a readiness probe** that runs the setup profile install/check commands in the agent environment before model spend, and falls back to a host-command binding when AgentOS cannot satisfy the toolchain.
3. **Environment issues must be durable** in the `agent_environment_issues` table and surfaced as Discord milestones so the operator sees actionable blockers instead of generic agent failures.
4. **No production code depends on this spike yet.** The helpers are isolated under `test/`; the real MachineEnvironment, TurnRunner, and ConversationLog modules will be built in milestone 2 and later.
