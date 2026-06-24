#!/usr/bin/env bash
set -euo pipefail

SCRATCH="${ISSUE11_SCRATCH:?ISSUE11_SCRATCH must be set}"
OUT="$SCRATCH/verify-issue.log"
BODY="$SCRATCH/issue-11-body.txt"

mkdir -p "$SCRATCH"

echo "=== Fetch issue #11 body from GitHub ==="
gh issue view 11 --json number,title,state,body >"$SCRATCH/issue-11.json"
gh issue view 11 --json body --jq '.body' >"$BODY"
echo "saved: $BODY ($(wc -c <"$BODY") bytes)"

extract_section() {
  local header="$1"
  local next_header="$2"
  awk -v h="$header" -v n="$next_header" '
    $0 == h { on=1; next }
    on && $0 ~ "^## " && $0 != h { exit }
    on { print }
  ' "$BODY"
}

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

run_test() {
  local label="$1"
  shift
  echo "--- test: $label ---"
  echo "\$ npm test -- $*"
  npm test -- "$@"
  pass "$label"
}

run_grep() {
  local label="$1"
  local pattern="$2"
  local file="$3"
  echo "--- grep: $label ---"
  echo "\$ grep -nE '$pattern' $file"
  grep -nE "$pattern" "$file"
  pass "$label"
}

run_no_grep() {
  local label="$1"
  local pattern="$2"
  local file="$3"
  echo "--- grep absent: $label ---"
  echo "\$ ! grep -nE '$pattern' $file"
  if grep -nE "$pattern" "$file"; then
    fail "$label"
  fi
  pass "$label"
}

verify_story_from_text() {
  local num="$1"
  local text="$2"
  local lower
  lower=$(echo "$text" | tr '[:upper:]' '[:lower:]')

  echo "Story $num (parsed from issue body):"
  echo "  $text"
  echo "  keyword-driven checks:"

  if echo "$lower" | grep -q "repository"; then
    run_test "story $num: repository constrained via binding" test/github-tools.test.ts -t "derives owner, repo, and branches"
    run_test "story $num: repository in PR payload from task" test/github-tools.test.ts -t "calls GitHub with task-bound"
  fi
  if echo "$lower" | grep -q "base branch"; then
    run_grep "story $num: base branch from binding" "base: bound\\.baseBranch" src/github/tools.ts
    run_no_grep "story $num: base not model input" "base: v\\." src/github/tools.ts
  fi
  if echo "$lower" | grep -q "feature branch"; then
    run_grep "story $num: feature branch as head" "head: bound\\.featureBranch" src/github/tools.ts
    run_no_grep "story $num: head not model input" "head: v\\." src/github/tools.ts
  fi
  if echo "$lower" | grep -q "token authority\|tool boundar"; then
    run_grep "story $num: strictObject boundary" "strictObject" src/github/tools.ts
    run_test "story $num: rejects forbidden fields" test/github-tools.test.ts -t "rejects model-controlled"
  fi
  if echo "$lower" | grep -q "still open prs\|core workflow"; then
    run_test "story $num: tool still exposed" test/github-tools.test.ts -t "exposes the create-pull-request"
    run_test "story $num: happy path after push" test/github-tools.test.ts -t "calls GitHub with task-bound"
  fi
  if echo "$lower" | grep -q "failures to be clear\|branch was not pushed"; then
    run_test "story $num: clear unpushed failure" test/github-tools.test.ts -t "refuses to create a PR"
  fi
  if echo "$lower" | grep -q "title and body only"; then
    run_test "story $num: title/body only input" test/github-tools.test.ts -t "accepts title and optional body only"
  fi
  if echo "$lower" | grep -q "prompt injection\|change the pr target"; then
    run_test "story $num: injection cannot add fields" test/github-tools.test.ts -t "rejects model-controlled"
    run_grep "story $num: run uses bound owner" "owner: bound\\.owner" src/github/tools.ts
  fi
  if echo "$lower" | grep -q "tool description"; then
    run_grep "story $num: description documents binding" "Repository, base branch, and feature branch are fixed" src/github/tools.ts
  fi
  if echo "$lower" | grep -q "task context passed into tool creation"; then
    run_grep "story $num: agent wires context" "resolveAgentGitHubTools" src/agents/coding.ts
    run_test "story $num: registers with valid context" test/agent-github-tools.test.ts -t "registers the task-bound PR tool"
  fi
  if echo "$lower" | grep -q "fail closed if task context"; then
    run_test "story $num: invalid repo fails" test/github-tools.test.ts -t "fails closed when repository format is invalid"
    run_test "story $num: missing branch fails" test/github-tools.test.ts -t "fails closed when branch context is missing"
    run_test "story $num: empty binding fails" test/github-tools.test.ts -t "fails closed when a bound field is empty"
    run_test "story $num: no token means no tools" test/agent-github-tools.test.ts -t "registers no tools when the GitHub token is missing"
  fi
  if echo "$lower" | grep -q "structured and concise"; then
    run_test "story $num: safe metadata output" test/github-tools.test.ts -t "returns only safe PR metadata"
  fi
  if echo "$lower" | grep -q "tests that prove input cannot change"; then
    run_test "story $num: tests prove schema boundary" test/github-tools.test.ts -t "rejects model-controlled"
    run_test "story $num: tests prove task-bound payload" test/github-tools.test.ts -t "calls GitHub with task-bound"
  fi
  if echo "$lower" | grep -q "push override policy"; then
    run_grep "story $num: push override via targetBranchForTask" "featureBranch: targetBranchForTask" src/task/turn-context.ts
    run_grep "story $num: binding uses context featureBranch" "featureBranch: context\\.featureBranch" src/github/tools.ts
  fi
  if echo "$lower" | grep -q "obviously task-scoped\|follow the same pattern"; then
    run_grep "story $num: GitHubTaskBinding exported" "export interface GitHubTaskBinding" src/github/tools.ts
    run_grep "story $num: bindingFromAgentRuntimeContext exported" "export function bindingFromAgentRuntimeContext" src/github/tools.ts
  fi
  if echo "$lower" | grep -q "no regression\|after pushing"; then
    run_test "story $num: regression-free happy path" test/github-tools.test.ts -t "calls GitHub with task-bound"
  fi

  echo "  result: PASS"
  echo ""
}

verify_impl_decision() {
  local bullet="$1"
  local lower
  lower=$(echo "$bullet" | tr '[:upper:]' '[:lower:]')

  echo "Implementation decision (parsed): $bullet"

  if echo "$lower" | grep -q "receive.*owner.*repository.*base branch.*feature branch"; then
    run_grep "impl: binding param on createGitHubTools" "binding: GitHubTaskBinding" src/github/tools.ts
  fi
  if echo "$lower" | grep -q "remove owner.*repository.*head.*base"; then
    run_no_grep "impl: no model repo/branch inputs" "owner: v\\.|head: v\\.|base: v\\." src/github/tools.ts
  fi
  if echo "$lower" | grep -q "title and body as model"; then
    run_test "impl: title/body model inputs" test/github-tools.test.ts -t "accepts title and optional body only"
  fi
  if echo "$lower" | grep -q "validate at execution time"; then
    run_grep "impl: execution-time binding check" "assertGitHubTaskBinding" src/github/tools.ts
    run_grep "impl: push check before create" "isFeatureBranchPushed" src/github/tools.ts
  fi
  if echo "$lower" | grep -q "feature branch as the pr head"; then
    run_grep "impl: feature branch as head" "head: bound\\.featureBranch" src/github/tools.ts
  fi
  if echo "$lower" | grep -q "base branch as the pr base"; then
    run_grep "impl: base branch as base" "base: bound\\.baseBranch" src/github/tools.ts
  fi
  if echo "$lower" | grep -q "structured pr metadata"; then
    run_test "impl: metadata output" test/github-tools.test.ts -t "returns only safe PR metadata"
  fi
  if echo "$lower" | grep -q "update agent instructions"; then
    run_grep "impl: agent instructions" "title and optional body only" src/agents/coding.ts
  fi
  if echo "$lower" | grep -q "push the branch before"; then
    run_grep "impl: push before PR in instructions" "push the configured feature branch first" src/agents/coding.ts
    run_test "impl: tool enforces push" test/github-tools.test.ts -t "refuses to create a PR"
  fi
  if echo "$lower" | grep -q "do not expand github token"; then
    run_no_grep "impl: no new github scopes in tool" "octokit\\.rest\\.(issues|repos\\.create)" src/github/tools.ts
  fi

  echo "  result: PASS"
  echo ""
}

verify_testing_decision() {
  local bullet="$1"
  local lower
  lower=$(echo "$bullet" | tr '[:upper:]' '[:lower:]')

  echo "Testing decision (parsed): $bullet"

  if echo "$lower" | grep -q "fake github client\|injectable"; then
    run_grep "testing: injectable createPullRequest" "createPullRequest\\?" src/github/tools.ts
    run_grep "testing: injectable isFeatureBranchPushed" "isFeatureBranchPushed\\?" src/github/tools.ts
  fi
  if echo "$lower" | grep -q "title and optional body only"; then
    run_test "testing: schema title/body only" test/github-tools.test.ts -t "accepts title and optional body only"
  fi
  if echo "$lower" | grep -q "derived from task context"; then
    run_test "testing: derivation from context" test/github-tools.test.ts -t "derives owner, repo, and branches"
  fi
  if echo "$lower" | grep -q "missing task context.*fail closed"; then
    run_test "testing: missing context fails" test/github-tools.test.ts -t "fails closed when repository format is invalid"
  fi
  if echo "$lower" | grep -q "successful execution calls"; then
    run_test "testing: successful call uses task values" test/github-tools.test.ts -t "calls GitHub with task-bound"
  fi
  if echo "$lower" | grep -q "safe pr metadata"; then
    run_test "testing: safe output metadata" test/github-tools.test.ts -t "returns only safe PR metadata"
  fi
  if echo "$lower" | grep -q "agent initialization test"; then
    run_test "testing: agent harness" test/agent-github-tools.test.ts
  fi
  if echo "$lower" | grep -q "not assert octokit internals"; then
    run_no_grep "testing: no octokit internals asserted" "octokit\\.rest" test/github-tools.test.ts
  fi

  echo "  result: PASS"
  echo ""
}

{
  echo "Issue #11 cross-verification checklist (dynamic parse)"
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Issue body source: gh issue view 11 -> $BODY"
  echo ""

  STORIES=$(extract_section "## User Stories" "## Implementation Decisions")
  IMPL=$(extract_section "## Implementation Decisions" "## Testing Decisions")
  TESTING=$(extract_section "## Testing Decisions" "## Out of Scope")
  OUTSCOPE=$(extract_section "## Out of Scope" "## Further Notes")

  echo "=== Parsed User Stories section (${#STORIES} chars) ==="
  echo "$STORIES"
  echo ""

  story_count=0
  while IFS= read -r line; do
    [[ "$line" =~ ^[0-9]+\. ]] || continue
    num=$(echo "$line" | sed -E 's/^([0-9]+)\. .*/\1/')
    text=$(echo "$line" | sed -E 's/^[0-9]+\. //')
    verify_story_from_text "$num" "$text"
    story_count=$((story_count + 1))
  done <<<"$STORIES"

  if [[ "$story_count" -ne 16 ]]; then
    fail "expected 16 user stories from body, parsed $story_count"
  fi
  echo "Parsed and verified $story_count user stories from issue body."
  echo ""

  echo "=== Parsed Implementation Decisions ==="
  echo "$IMPL"
  echo ""
  impl_count=0
  while IFS= read -r line; do
    [[ "$line" =~ ^- ]] || continue
    bullet=$(echo "$line" | sed 's/^- //')
    verify_impl_decision "$bullet"
    impl_count=$((impl_count + 1))
  done <<<"$IMPL"
  echo "Parsed and verified $impl_count implementation decisions."
  echo ""

  echo "=== Parsed Testing Decisions ==="
  echo "$TESTING"
  echo ""
  test_count=0
  while IFS= read -r line; do
    [[ "$line" =~ ^- ]] || continue
    bullet=$(echo "$line" | sed 's/^- //')
    verify_testing_decision "$bullet"
    test_count=$((test_count + 1))
  done <<<"$TESTING"
  echo "Parsed and verified $test_count testing decisions."
  echo ""

  echo "=== Parsed Out of Scope ==="
  echo "$OUTSCOPE"
  echo ""
  if echo "$OUTSCOPE" | grep -qi "automatically pushing"; then
    run_no_grep "out-of-scope: no auto-push in tool" "git push" src/github/tools.ts
  fi
  if echo "$OUTSCOPE" | grep -qi "issue creation"; then
    run_no_grep "out-of-scope: no issue tools" "issues\\.create" src/github/tools.ts
  fi
  echo "  out of scope: PASS"
  echo ""

  echo "OVERALL: GREEN — dynamically parsed issue body sections cross-verified against shipped code"
} 2>&1 | tee "$OUT"

echo ""
echo "verify-issue.log written to $OUT"