# Plan 005: Tool resilience for weaker models (presentation · coercion · repair)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer maintains the index.
>
> **Drift check (run first)**:
> ```bash
> git diff --stat d3c600a..HEAD -- \
>   src/agents/coding.ts src/agents/setup.ts \
>   src/agents/prompts/prompt-blocks.ts src/agents/prompts/compose.ts \
>   src/discord/thread-message-tool.ts src/discord/final-output-validator.ts \
>   src/github/tools.ts src/skills/skill-tool.ts src/skills/discover.ts \
>   src/setup/tools.ts src/setup/memory-tools.ts \
>   src/flue/tool-failure-guard.ts src/flue/agent-guardrails.ts \
>   scripts/patch-flue-runtime-abort.mjs package.json
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (Flue postinstall patch + model-facing contracts; coercion must not invent required values)
- **Depends on**: none (orthogonal to pg-boss plans 001–004, which are DONE)
- **Category**: reliability / small-model support
- **Planned at**: commit `d3c600a`, 2026-07-09
- **Branch**: `pd/feat/tool-resilience` from `main` at plan HEAD (or current `main` if still at/after `d3c600a`)

---

## Why this matters

Weaker models mis-key tool args (`text` instead of `message`, snake_case, nested `{ payload: … }`, string `"2"` for `page`). Today Threadcord relies on (1) prompt prose (`TOOL_ARGUMENTS`), (2) mild type coercion inside pi-ai `validateToolArguments`, (3) Flue’s valibot wrap on custom tools, and (4) a consecutive-failure abort (`AGENT_MAX_VALIDATION_FAILURES=3`). Wrong **keys** fail before app code runs; schema error text is a single dense Flue line; semantic throws are uneven. This plan ports **patterns** from pr-agent (prose contracts + best-effort coerce + path-oriented repair messages) into Threadcord’s coding/setup agents — **not** pr-agent’s PR-review harness.

Success = fewer validation spirals and fewer validation-guard trips on custom tools, without inventing side-effectful args or forking the agent loop.

---

## Current state

### Call chain (this install — verified)

1. Model emits tool-call args.
2. **pi-agent-core** `prepareToolCallArguments` — only if `AgentTool.prepareArguments` is set (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:348–358`).
3. **pi-ai** `validateToolArguments` — TypeBox convert + JSON Schema check; throws multi-line `Validation failed for tool "…":` (`…/pi-ai/dist/utils/validation.js:253–279`).
4. Flue custom tool `execute` → already-wrapped by `defineTool` / `normalizeToolDefinition`: `v.safeParse` then user `execute`; failures throw `ToolInputValidationError` with message  
   `Arguments for tool "…" do not match the required schema: …. Call the tool again with corrected arguments.`  
   (`@flue/runtime/dist/tool-DchpwkJi.mjs:71–92`, `errors-PCpj4Dkf.mjs:430–443`).
5. User `execute` may throw semantic `Error`s (final-output, skill miss, setup verify).
6. Observe-bridge + `maybeAbortOnToolFailures` (`src/flue/tool-failure-guard.ts`).

**Critical gap**: Flue `ToolDefinition` is only `{ name, description, parameters, execute }` (`tool-types-6GUMYEa-.d.mts:27–36`). `createCustomTools` maps those four fields onto `AgentTool` and **does not** set `prepareArguments` (locate `createCustomTools(tools, builtinTools)` under `@flue/runtime/dist/*.mjs` — hashed filenames change). So key-alias rescue **before** JSON Schema validation requires a small Flue postinstall patch (same style as abort patch).

`normalizeToolDefinition` does `{ ...tool, parameters, execute: wrapped }` — extra properties on the object passed into `defineTool` (e.g. `prepareArguments`) are **preserved** on the frozen tool object if present at definition time, but are still dropped by `createCustomTools` unless patched.

### Files and roles

| Path | Role |
|------|------|
| `src/agents/prompts/prompt-blocks.ts` | `TOOL_ARGUMENTS` (L27–36), `TOOL_USE` (L38–43), setup blocks (`SETUP_OUTPUT` L126–132, `WHEN_DONE_SETUP` L156–157) |
| `src/agents/prompts/compose.ts` | Joins blocks; coding includes `TOOL_ARGUMENTS`+`TOOL_USE` (L89–90); setup does **not** |
| `src/agents/coding.ts` | Assembles custom tools (L48–53) |
| `src/agents/setup.ts` | `tools: createSetupTools(run.id)` (L32) |
| `src/discord/thread-message-tool.ts` | `post_thread_message` / `post_thread_report` valibot + `validateFinalOutput` |
| `src/skills/skill-tool.ts` | `skill` tool; miss/list/read |
| `src/skills/discover.ts` | `normalizeSkillLookupName` already strips leading `/` (L137–140) — **not** a new coerce win |
| `src/github/tools.ts` | `create_github_pull_request` |
| `src/setup/tools.ts` | `save_threadcord_setup_profile` |
| `src/setup/memory-tools.ts` | `append_threadcord_setup_memory` |
| `src/discord/final-output-validator.ts` | Semantic final-output rules |
| `src/flue/tool-failure-guard.ts` | Consecutive abort; `isValidationFailure` substring heuristics (L52–66) |
| `src/flue/agent-guardrails.ts` | `DEFAULT_AGENT_MAX_TOOL_FAILURES=10`, `DEFAULT_AGENT_MAX_VALIDATION_FAILURES=3` |
| `scripts/patch-flue-runtime-abort.mjs` | Precedent postinstall patch (marker + needles + exit 1 on miss) |
| `package.json` | `"postinstall": "node scripts/patch-flue-runtime-abort.mjs"` |

### Current excerpts (confirm before coding)

`TOOL_ARGUMENTS` / `TOOL_USE` today (`src/agents/prompts/prompt-blocks.ts`):

```ts
export const TOOL_ARGUMENTS = `TOOL ARGUMENTS (strict JSON — wrong or extra keys fail validation before the tool runs)
Pass only the parameter names listed here. There is no \`description\` field on built-in tools.
- read: \`path\` (string, required). Optional: \`offset\` (line number), \`limit\` (line count).
// … write/edit/bash/grep/glob/task …
Threadcord tools: post_thread_message (\`message\`), post_thread_report (\`parts\`: string[]), append_threadcord_setup_memory (\`markdown\`), create_github_pull_request (\`owner\`, \`repo\`, \`title\`, \`head\`, \`base\`; optional \`body\`), skill (\`action\`: \`list\` or \`read\`, required; optional \`name\` string — required when action is \`read\`, bare skill id e.g. \`prath-mode\` not \`/prath-mode\`; optional \`page\` integer 1-based when action is \`list\`, 25 skills per page).`;

export const TOOL_USE = `TOOL USE
- Tool-specific args only: never \`path\` on bash; never \`command\` on read/write/edit/grep/glob.
// …
- On "Validation failed" / "must have required properties": fix keys per TOOL ARGUMENTS and retry once — never resend the same rejected payload.
// …`;
```

`createCustomTools` (locate under `node_modules/@flue/runtime/dist/` by grepping `createCustomTools(tools, builtinTools)`):

```js
return {
  name: toolDef.name,
  label: toolDef.name,
  description: toolDef.description,
  parameters: toolDef.parameters,
  async execute(_toolCallId, params, signal) {
    // … calls toolDef.execute(params, signal)
  }
};
```

`defineTool` wrap (`tool-DchpwkJi.mjs` pattern):

```js
async execute(args, signal) {
  const parsed = v.safeParse(schema, args);
  if (!parsed.success) throw new ToolInputValidationError({ tool: tool.name, issues: … });
  return execute(parsed.output, signal);
}
```

Skill slash already handled (`src/skills/discover.ts:137–150`):

```ts
export function normalizeSkillLookupName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}
```

### Conventions to match

- ESM, `"type": "module"`, import paths end in `.js`.
- Strict TS (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
- Tools: `defineTool` + valibot (`valibot` 1.4.1); **not** Zod for tool args (Zod is config-only).
- Tests: Vitest, model after `test/tool-descriptions.test.ts` and `test/agent-prompts.test.ts` (string `toContain` contracts).
- Branch naming: `pd/<type>/<name>` (see Agents.md / Claude.md).
- Commit style: conventional (`feat:`, `fix:`, `docs:`) — recent log: `feat: add pg-boss queue foundation`, `docs: update README for pg-boss queue`.
- Flue patches: idempotent marker, exit 0 if already applied, exit 1 if anchors missing (see `scripts/patch-flue-runtime-abort.mjs`).

### What NOT to copy from pr-agent

- Review severity / findings maps, publish recovery, submit-only repair harness (`runValidationRepairLoop` + restrict tools to submit).
- Cursor MCP dual runtime.
- Simplified schemas per model size.
- Reimplementing Flue built-ins (`read`/`bash`/…).

---

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run check` | exit 0 |
| All tests | `npm test` | exit 0 |
| Focused tests | `npm test -- agent-prompts tool-descriptions coerce format-validation tool-failure-guard final-output` | exit 0 |
| Re-apply patches | `npm run postinstall` | exit 0 |
| Scope check | `git status --porcelain` | only in-scope paths |

Node ≥22.18 for build; unit tests mock DB and do not require Postgres.

---

## Scope

### In scope (only these may be modified or created)

**Create:**
- `src/tools/types.ts`
- `src/tools/fix-double-escaped-string.ts`
- `src/tools/coerce-common.ts`
- `src/tools/coerce-tool-args.ts`
- `src/tools/resilient-tool.ts`
- `src/tools/format-validation-error.ts`
- `scripts/patch-flue-prepare-arguments.mjs`
- `test/fix-double-escaped-string.test.ts`
- `test/coerce-common.test.ts`
- `test/coerce-tool-args.test.ts`
- `test/format-validation-error.test.ts`
- (extend existing tests listed below)

**Modify:**
- `package.json` (postinstall chain only)
- `src/agents/prompts/prompt-blocks.ts`
- `src/agents/prompts/compose.ts`
- `src/discord/thread-message-tool.ts`
- `src/skills/skill-tool.ts`
- `src/github/tools.ts`
- `src/setup/tools.ts`
- `src/setup/memory-tools.ts`
- `src/discord/final-output-validator.ts` (message wording only, if needed)
- `src/flue/tool-failure-guard.ts` (only if new error prefixes need classifier coverage — prefer making prefixes already match)
- `test/agent-prompts.test.ts`
- `test/tool-descriptions.test.ts`
- `test/final-output-validator.test.ts`
- `test/tool-failure-guard.test.ts` (if classifier touched)
- `plans/README.md` (status row only when done)

### Out of scope

- Built-in Flue tools (`read`/`write`/`edit`/`bash`/`grep`/`glob`/`task`) implementation.
- MCP tool coerce matrix / per-server aliases.
- Changing `DEFAULT_AGENT_MAX_*` thresholds as the primary fix.
- pr-agent submit-only repair harness / Cursor bridge.
- New DB tables, Discord UX redesign, README product marketing.
- Loosening valibot schemas to “accept any keys” without coerce+strict path.
- Inventing required field content when missing.
- Claiming skill `/name` strip as a new feature (already in `discover.ts`).

---

## Git workflow

- Branch: `pd/feat/tool-resilience` from `main`.
- One commit per phase (A presentation → B coerce+patch → C repair).
- Do **not** push or open a PR unless the operator asks.
- Do **not** amend published history.

---

## Architecture decision (locked — do not re-open)

| Layer | Mandatory approach |
|-------|-------------------|
| **Presentation** | Prompt + description string improvements only. Keep tight schemas. |
| **Coercion** | Pure `coerceToolArgs(toolName, raw)` + **`prepareArguments` forwarded by Flue postinstall patch** so aliases run **before** pi-ai + valibot. |
| **Repair** | App-owned **semantic** error formatting only. Do **not** claim to rewrite Flue `ToolInputValidationError` text without a separate Flue change (out of MVP). |

**Rejected alternatives (do not implement):**
- Execute-only coerce after valibot as the sole alias path (cannot rescue missing canonical keys).
- Dual optional “2a vs 2b” left to the executor — **not allowed**. If the prepareArguments patch anchors cannot be found, **STOP** after Phase A and report; do not ship half-broken alias maps.

---

## Steps

### Step 0: Branch + drift

```bash
git checkout main && git pull --ff-only   # if remote available; else skip pull
git checkout -b pd/feat/tool-resilience
# run drift check from header
```

**Verify**: `git branch --show-current` → `pd/feat/tool-resilience`. Drift diff empty or reconciled with plan excerpts.

---

### Phase A — Presentation (commit 1)

#### Step A1: Expand coding `TOOL_ARGUMENTS` / `TOOL_USE`

**File:** `src/agents/prompts/prompt-blocks.ts`

Keep existing tool lines. **Append** to the Threadcord tools paragraph (same template string) these exact clarifying sentences (must match test strings below):

1. After Threadcord tools list, add:  
   `Common wrong keys that fail: post_thread_message needs \`message\` (not text/content/body); post_thread_report needs \`parts\` as string[] (not one string); bash needs \`command\` (not cmd/path); skill read needs bare \`name\` (slash optional at runtime but prefer bare).`
2. In `TOOL_USE`, change the validation bullet to mention **both** provider error shapes:  
   `On "Validation failed for tool" / "Arguments for tool" / "do not match the required schema" / "must have required properties": fix keys per TOOL ARGUMENTS and retry once — never resend the same rejected payload. Read each path/message line in the error.`

Do **not** bloat the prompt with full JSON examples.

**Verify**:
```bash
npm test -- agent-prompts
```
→ pass. Then add assertions in `test/agent-prompts.test.ts` (coding prompt-consistency describe):

```ts
expect(prompt).toContain("Common wrong keys that fail");
expect(prompt).toContain("not text/content/body");
expect(prompt).toContain("parts` as string[]");
expect(prompt).toContain("Arguments for tool");
expect(prompt).toContain("do not match the required schema");
```

**Verify again**: `npm test -- agent-prompts` → pass.

#### Step A2: Setup tool-arg block

**Files:** `src/agents/prompts/prompt-blocks.ts`, `src/agents/prompts/compose.ts`

Add export:

```ts
export const SETUP_TOOL_ARGUMENTS = `SETUP TOOL ARGUMENTS
Call \`save_threadcord_setup_profile\` with exactly:
- environment: object with install (required non-empty bash one-liner), optional start, checks, requiredEnv, requiredServices, skills
- memoryMarkdown: string (names only for secrets; no token values)
Wrong keys (memory_markdown, payload wrapping) fail validation. Save only after install and every proposed check already passed in this workspace.`;
```

In `compose.ts` setup branch, insert `SETUP_TOOL_ARGUMENTS` **after** `SETUP_OUTPUT` and **before** `SETUP_SAVE_CONTRACT` (import it).

**Verify**:
```bash
npm test -- agent-prompts
```
Add setup-prompt assertion:

```ts
expect(prompt).toContain("SETUP TOOL ARGUMENTS");
expect(prompt).toContain("memoryMarkdown");
expect(prompt).toContain("save_threadcord_setup_profile");
```

(Use the existing setup `composePrompt({ role: "setup", … })` describe block.)

#### Step A3: Description micro-contracts (no API changes)

For each factory, ensure `description` still lists **canonical parameter names** in prose. Only add a phrase if missing:

| Tool | Action |
|------|--------|
| `post_thread_message` / `post_thread_report` / `skill` / `create_github_pull_request` | already strong — leave unless a pin breaks |
| `append_threadcord_setup_memory` | ensure “parameter `markdown`” appears once if missing |
| `save_threadcord_setup_profile` | ensure “parameters: environment, memoryMarkdown” appears once if missing |

Prefer **not** rewriting long descriptions that `test/tool-descriptions.test.ts` already pins.

**Verify**: `npm test -- tool-descriptions agent-prompts` → pass.

#### Step A4: Commit phase A

```bash
git add src/agents/prompts/prompt-blocks.ts src/agents/prompts/compose.ts test/agent-prompts.test.ts test/tool-descriptions.test.ts
git commit -m "feat: clarify tool argument contracts for weaker models"
```

**Verify**: `npm run check` → 0; `npm test` → 0.

---

### Phase B — Coercion + Flue `prepareArguments` patch (commit 2)

#### Step B1: Pure helpers

**Create** `src/tools/types.ts`:

```ts
export type CoerceResult = {
  value: Record<string, unknown>;
  coercions: string[];
};
```

**Create** `src/tools/fix-double-escaped-string.ts`  
Port the **idea** of pr-agent’s helper (detect literal `\\n` etc.; optional JSON-parse of a quoted whole string; else manual unescape). Export:

```ts
export function fixDoubleEscapedString(value: string): { text: string; fixed: boolean };
```

**Create** `src/tools/coerce-common.ts` with pure functions:

| Function | Behavior | Label(s) |
|----------|----------|----------|
| `unwrapEnvelope(raw, keys)` | If raw is object and has one of `payload`/`data`/`result`/`args` whose value is a non-array object, return that object | `unwrap_<key>` |
| `aliasKeys(obj, map)` | For each `[from, to]`, if `to` missing and `from` present, copy and delete `from` | `alias_<from>_to_<to>` |
| `coercePositiveInt(value)` | digit string → int; already int → pass; else undefined | used by callers |
| `stripWholeStringCodeFence(s)` | only if entire trimmed string is one fenced block | `fence_strip` |
| `trimString(s)` | trim | `trim` when changed |

**Rules:** never invent missing values; never invent string content for empty required fields. If both canonical and alias keys exist, **keep canonical** (do not overwrite).

**Create** `src/tools/coerce-tool-args.ts`:

```ts
export function coerceToolArgs(
  toolName: string,
  raw: unknown,
): CoerceResult;
```

If `raw === null || typeof raw !== "object" || Array.isArray(raw)`:

```ts
return { value: {}, coercions: [] }; // empty object → required fields fail honestly
```

Otherwise clone into a mutable `Record<string, unknown>` and apply:

| `toolName` | Transforms (in order) |
|------------|------------------------|
| `post_thread_message` | unwrap → alias `text\|content\|body`→`message` → fence/double-escape/trim on `message` |
| `post_thread_report` | unwrap → alias `messages\|sections`→`parts` → if `parts` is a non-empty string, wrap `[parts]` label `parts_string_to_array` → fence/trim each string element |
| `skill` | unwrap → alias `skill\|skillName\|id`→`name`; `mode`→`action` → lowercase `action` if string (`list`/`read`) → strip leading `/` + trim on `name` label `skill_name_slash_strip` → `page` via `coercePositiveInt` |
| `create_github_pull_request` | unwrap → alias `branch`→`head`, `base_branch`→`base`, `description`→`body` → trim string fields |
| `append_threadcord_setup_memory` | unwrap → alias `text\|content\|memory`→`markdown` → fence/double-escape/trim `markdown` |
| `save_threadcord_setup_profile` | unwrap → alias `memory_markdown`→`memoryMarkdown` → if `environment` is object, alias `required_env`→`requiredEnv`, `required_services`→`requiredServices` |
| unknown tool name | return clone with empty coercions (no transforms) |

**Tests — create** with fixtures:

`test/fix-double-escaped-string.test.ts`:
- `"hello\\nworld"` → fixed true, contains real newline
- `"plain"` → fixed false

`test/coerce-common.test.ts`:
- unwrap `payload`
- alias map
- fence strip whole only (mid-string fence unchanged)
- positive int `"3"` → 3; `"3.5"` → undefined

`test/coerce-tool-args.test.ts` (minimum cases):

| Case | Input (abbreviated) | Expect |
|------|---------------------|--------|
| message alias | `{ text: "## Summary\\n\\nDone work here with enough body." }` for `post_thread_message` | `message` set; coercions include `alias_text_to_message` |
| parts string | `{ parts: "## A\\n\\nbody…" }` for `post_thread_report` | `parts` is length-1 array |
| skill aliases | `{ mode: "READ", skill: "/prath-mode", page: "2" }` | action `read`, name `prath-mode`, page `2` |
| PR aliases | `{ branch: "threadcord/feat/x", base_branch: "main", owner, repo, title }` | head/base set |
| no invent | `{ }` for `post_thread_message` | no `message` key; coercions empty |
| identity | correct shape | `coercions` empty |
| prefer canonical | `{ message: "a", text: "b" }` | `message` stays `"a"` |

**Verify**: `npm test -- fix-double-escaped coerce-common coerce-tool-args` → pass.

#### Step B2: Flue prepareArguments patch

**Create** `scripts/patch-flue-prepare-arguments.mjs` modeled on `scripts/patch-flue-runtime-abort.mjs`:

1. Resolve `node_modules/@flue/runtime/dist`.
2. Find the `.mjs` file that contains the literal `createCustomTools(tools, builtinTools)` (do **not** hardcode the hashed filename).
3. Marker: unique string e.g. `prepareArguments: typeof toolDef.prepareArguments` — if present, `process.exit(0)`.
4. Anchors: the object returned inside `createCustomTools` that sets `parameters: toolDef.parameters` immediately before `async execute(_toolCallId`.
5. Insert after `parameters: toolDef.parameters,` a line matching local formatting:  
   `prepareArguments: typeof toolDef.prepareArguments === "function" ? toolDef.prepareArguments : undefined,`
6. If anchors missing → `console.error` + `process.exit(1)`.
7. Write file; log success.

**Update** `package.json`:

```json
"postinstall": "node scripts/patch-flue-runtime-abort.mjs && node scripts/patch-flue-prepare-arguments.mjs"
```

**Verify**:
```bash
node scripts/patch-flue-prepare-arguments.mjs   # exit 0
node scripts/patch-flue-prepare-arguments.mjs   # idempotent exit 0
rg -n "prepareArguments: typeof toolDef.prepareArguments" node_modules/@flue/runtime/dist
```
→ at least one match.

If anchors cannot be found: **STOP** (do not invent looser schemas). Phase A may already be committed; leave Phase B incomplete and report.

#### Step B3: `defineResilientTool` + wire factories

**Create** `src/tools/resilient-tool.ts`:

```ts
import { defineTool } from "@flue/runtime";
import { coerceToolArgs } from "./coerce-tool-args.js";

// Flue ToolDefinition types omit prepareArguments; runtime preserves extras via ...tool.
export function defineResilientTool(
  def: Parameters<typeof defineTool>[0],
): ReturnType<typeof defineTool> {
  const toolName = def.name;
  const withPrepare = {
    ...def,
    prepareArguments: (args: unknown) => {
      const { value, coercions } = coerceToolArgs(toolName, args);
      if (coercions.length > 0) {
        console.debug("[threadcord] tool_args_coerced", { tool: toolName, coercions });
      }
      return value;
    },
  };
  return defineTool(withPrepare as Parameters<typeof defineTool>[0]);
}
```

If TypeScript rejects the extra property, use `as unknown as Parameters<typeof defineTool>[0]` — do **not** change Flue’s published types.

**Replace** `defineTool(` with `defineResilientTool(` in:

- `src/discord/thread-message-tool.ts` (both tools)
- `src/skills/skill-tool.ts`
- `src/github/tools.ts`
- `src/setup/tools.ts`
- `src/setup/memory-tools.ts`

Import from `../tools/resilient-tool.js` (adjust relative path per file).

Do **not** wrap MCP tools in this plan.

**Verify**:
```bash
npm run check
npm test -- coerce-tool-args tool-descriptions
```
→ pass.

Add a unit test that asserts `prepareArguments` exists on a resilient tool and aliases work:

```ts
const tools = createSkillTools("/tmp", "/tmp");
const skill = tools.find((t) => t.name === "skill")!;
expect(typeof (skill as { prepareArguments?: unknown }).prepareArguments).toBe("function");
const prepared = (skill as { prepareArguments: (a: unknown) => unknown }).prepareArguments({
  mode: "list",
});
expect(prepared).toMatchObject({ action: "list" });
```

Place in `test/coerce-tool-args.test.ts` or a small `test/resilient-tool.test.ts`.

**Verify**: `npm test -- coerce-tool-args resilient-tool` → pass (filter by file names that exist).

#### Step B4: Commit phase B

```bash
git add src/tools scripts/patch-flue-prepare-arguments.mjs package.json \
  src/discord/thread-message-tool.ts src/skills/skill-tool.ts src/github/tools.ts \
  src/setup/tools.ts src/setup/memory-tools.ts test/
git commit -m "feat: coerce near-miss tool arguments via prepareArguments"
```

**Verify**: `npm run check` → 0; `npm test` → 0; `npm run postinstall` → 0.

---

### Phase C — Semantic repair feedback (commit 3)

Honest boundary: **schema** failures still use Flue’s fixed `ToolInputValidationError` message. This phase improves **app-thrown** semantic errors and prompt guidance only.

#### Step C1: Formatter

**Create** `src/tools/format-validation-error.ts`:

```ts
export function formatToolValidationError(params: {
  toolName: string;
  issues: ReadonlyArray<{ path?: ReadonlyArray<string | number | symbol>; message: string }>;
  requiredReminder: string;
}): string {
  const lines = [`${params.toolName} validation failed:`];
  for (const issue of params.issues) {
    const path =
      issue.path && issue.path.length > 0
        ? issue.path.map(String).join(".")
        : "(root)";
    lines.push(`- ${path}: ${issue.message}`);
  }
  lines.push(params.requiredReminder);
  lines.push(
    `Fix the fields above and call ${params.toolName} again. Do not resend the same payload.`,
  );
  return lines.join("\n");
}
```

**Tests** (`test/format-validation-error.test.ts`): multi-issue formatting; empty path → `(root)`; includes tool name and “Do not resend”.

#### Step C2: Wire semantic throws

1. **`skill-tool.ts`** — when `action === "read"` and missing `name`, throw via `formatToolValidationError` with path `name`, reminder covering action/name/page.

2. **`setup/tools.ts`** — when `validateSetupProfilePayload` returns `!ok`, throw a multi-line message:

```ts
throw new Error(
  [
    "save_threadcord_setup_profile validation failed:",
    `- (root): ${parsed.message}`,
    "Required: environment.install (non-empty), memoryMarkdown.",
    "Fix the fields above and call save_threadcord_setup_profile again. Do not resend the same payload.",
  ].join("\n"),
);
```

3. **`validateFinalOutput` / thread-message tools** — keep existing rejection semantics; only change wording if you also update `test/final-output-validator.test.ts`. Prefer leave-as-is if tests already assert exact strings.

**Do not** attempt to catch `ToolInputValidationError` inside app execute — it is thrown before user execute.

#### Step C3: Guard classifier smoke

`isValidationFailure` already matches `"validation"`. New messages containing `validation failed` continue to count as validation.

**Verify** existing `test/tool-failure-guard.test.ts` still passes. Optionally add one case whose result text is `skill validation failed:\n- name: Required…` if easy.

#### Step C4: Commit phase C

```bash
git add src/tools/format-validation-error.ts src/skills/skill-tool.ts src/setup/tools.ts \
  src/discord/final-output-validator.ts test/
git commit -m "feat: return structured semantic tool validation feedback"
```

**Verify**: `npm run check` → 0; `npm test` → 0.

---

## Test plan

| File | Pattern after | Cases |
|------|---------------|-------|
| `test/fix-double-escaped-string.test.ts` | new pure unit | unescape / no-op |
| `test/coerce-common.test.ts` | new pure unit | unwrap, alias, fence, int |
| `test/coerce-tool-args.test.ts` | new pure unit | per-tool aliases + no-invent + identity + prepareArguments smoke |
| `test/format-validation-error.test.ts` | new pure unit | path join, reminder |
| `test/agent-prompts.test.ts` | existing | new contract strings |
| `test/tool-descriptions.test.ts` | existing | unchanged pins still pass |
| `test/final-output-validator.test.ts` | existing | thin output still fails |
| `test/tool-failure-guard.test.ts` | existing | validation threshold |

**Final verification:**
```bash
npm run check
npm test
npm run postinstall
```
→ all exit 0.

---

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `npm test` exits 0
- [ ] Coding prompt contains `Common wrong keys that fail` and both error shape phrases (`Arguments for tool`, `do not match the required schema`)
- [ ] Setup prompt contains `SETUP TOOL ARGUMENTS` and `memoryMarkdown`
- [ ] `src/tools/coerce-tool-args.ts` exists with unit tests covering every custom tool name in the dispatch table
- [ ] `scripts/patch-flue-prepare-arguments.mjs` is idempotent; postinstall runs abort patch **and** prepareArguments patch
- [ ] `rg "prepareArguments: typeof toolDef.prepareArguments" node_modules/@flue/runtime/dist` matches after postinstall
- [ ] Custom Threadcord tools use `defineResilientTool` (no bare `defineTool` left in the five factory files — MCP/flue internals excluded)
- [ ] `DEFAULT_AGENT_MAX_VALIDATION_FAILURES` still `3` in `src/flue/agent-guardrails.ts`
- [ ] `git status --porcelain` shows only in-scope paths (plus plan status if updated)
- [ ] `plans/README.md` row 005 → `DONE` (or leave `TODO`/`IN PROGRESS` if stopped after Phase A only — say which)

---

## STOP conditions

Stop and report (do not improvise) if:

1. Drift check shows in-scope files no longer match “Current state” excerpts and you cannot reconcile.
2. `createCustomTools` / `prepareArguments` agent-loop order disappeared from this install’s `node_modules` (architecture change).
3. Patch anchors for `createCustomTools` cannot be found → ship **Phase A only**, leave coerce unmerged, report anchor miss with the `@flue/runtime` version from `package-lock.json`.
4. Any coerce path would invent secrets, absolute paths outside workspace, or PR head/base without model-provided values.
5. A verification command fails twice after a reasonable fix attempt.
6. Implementing a step appears to require out-of-scope files (built-in tools rewrite, MCP matrix, threshold raising as “the fix”).

---

## Maintenance notes

- **Reviewers:** scrutinize alias maps for silent wrong-key merges (prefer canonical if already set). Scrutinize the Flue patch for tab/format drift on runtime upgrades.
- **Flue upgrades:** both postinstall patches must be re-verified; hashed dist filenames change — patches must search by symbol, not fixed hash names.
- **Future:** upstream Flue PR for first-class `prepareArguments` on `ToolDefinition` would remove the patch. Built-in tool coerce would need Flue ownership. Optional metrics counters deferred (debug log is enough for MVP).
- **Skill slash:** already normalized in `discover.ts`; coerce slash-strip is defense-in-depth only.
- **Schema error text:** still Flue-owned; improving it is a separate Flue/patch plan.

---

## Appendix — pr-agent reference only (patterns, do not vendor)

Optional research clone: `https://github.com/prathamdby/pr-agent`  
Patterns: coerce-before-validate on submit tools; multiline `format*ValidationError`; **do not** port submit-only repair loops.
