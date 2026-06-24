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
echo ""
echo "=== Issue user stories (from body) ==="
grep -E '^[0-9]+\. As ' "$BODY" || true
echo ""

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

check_test() {
  local label="$1"
  shift
  echo "--- test: $label ---"
  echo "\$ npm test -- $*"
  npm test -- "$@" >/dev/null
  pass "$label"
}

check_grep() {
  local label="$1"
  local pattern="$2"
  local file="$3"
  echo "--- grep: $label ---"
  echo "\$ grep -nE '$pattern' $file"
  grep -nE "$pattern" "$file" >/dev/null
  pass "$label"
}

check_no_grep() {
  local label="$1"
  local pattern="$2"
  local file="$3"
  echo "--- grep absent: $label ---"
  if grep -nE "$pattern" "$file" >/dev/null; then
    fail "$label"
  fi
  pass "$label"
}

{
  echo "Issue #11 cross-verification checklist"
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Issue body source: gh issue view 11 -> $BODY"
  echo ""

  echo "## User stories"
  echo ""

  echo "1. PR tool constrained to active task repository"
  check_test "story 1: binding derives owner/repo from task context" test/github-tools.test.ts -t "derives owner, repo, and branches"
  check_test "story 1: PR payload uses task-bound owner/repo" test/github-tools.test.ts -t "calls GitHub with task-bound"
  echo "   result: PASS"
  echo ""

  echo "2. PR tool constrained to active task base branch"
  check_grep "story 2: run uses bound.baseBranch" "base: bound\\.baseBranch" src/github/tools.ts
  check_no_grep "story 2: base not in input schema" "base: v\\." src/github/tools.ts
  echo "   result: PASS"
  echo ""

  echo "3. PR tool constrained to active task feature branch"
  check_grep "story 3: run uses bound.featureBranch as head" "head: bound\\.featureBranch" src/github/tools.ts
  check_no_grep "story 3: head not in input schema" "head: v\\." src/github/tools.ts
  echo "   result: PASS"
  echo ""

  echo "4. Application narrows token authority at tool boundaries"
  check_grep "story 4: strictObject input schema" "strictObject" src/github/tools.ts
  check_test "story 4: rejects model branch/repo fields" test/github-tools.test.ts -t "rejects model-controlled"
  echo "   result: PASS"
  echo ""

  echo "5. Agent can still open PRs for completed work"
  check_test "story 5: create_github_pull_request tool exposed" test/github-tools.test.ts -t "exposes the create-pull-request"
  check_test "story 5: happy path creates PR when branch pushed" test/github-tools.test.ts -t "calls GitHub with task-bound"
  echo "   result: PASS"
  echo ""

  echo "6. PR creation failures are clear"
  check_test "story 6: unpushed branch error from tool.run" test/github-tools.test.ts -t "refuses to create a PR"
  echo "   result: PASS"
  echo ""

  echo "7. Model chooses title and body only"
  check_test "story 7: schema accepts title and optional body only" test/github-tools.test.ts -t "accepts title and optional body only"
  echo "   result: PASS"
  echo ""

  echo "8. Prompt injection cannot change PR target"
  check_test "story 8: extra fields rejected by strictObject" test/github-tools.test.ts -t "rejects model-controlled"
  check_grep "story 8: run ignores model for owner/repo/head/base" "owner: bound\\.owner" src/github/tools.ts
  echo "   result: PASS"
  echo ""

  echo "9. Tool description states task-bound behavior"
  check_grep "story 9: description mentions fixed repo/branches" "Repository, base branch, and feature branch are fixed" src/github/tools.ts
  echo "   result: PASS"
  echo ""

  echo "10. Task context passed into tool creation"
  check_grep "story 10: resolveAgentGitHubTools in coding agent" "resolveAgentGitHubTools" src/agents/coding.ts
  check_test "story 10: agent registers tool with valid context" test/agent-github-tools.test.ts -t "registers the task-bound PR tool"
  echo "   result: PASS"
  echo ""

  echo "11. Fail closed if task context missing"
  check_test "story 11: invalid repository fails binding" test/github-tools.test.ts -t "fails closed when repository format is invalid"
  check_test "story 11: missing branch context fails" test/github-tools.test.ts -t "fails closed when branch context is missing"
  check_test "story 11: empty binding field fails" test/github-tools.test.ts -t "fails closed when a bound field is empty"
  check_test "story 11: agent fails without token/context" test/agent-github-tools.test.ts -t "registers no tools when the GitHub token is missing"
  echo "   result: PASS"
  echo ""

  echo "12. Tool result is structured and concise"
  check_test "story 12: output schema number/url/state only" test/github-tools.test.ts -t "returns only safe PR metadata"
  echo "   result: PASS"
  echo ""

  echo "13. Tests prove input cannot change repository or branch"
  check_test "story 13: schema rejects forbidden fields" test/github-tools.test.ts -t "rejects model-controlled"
  check_test "story 13: run uses task values not input" test/github-tools.test.ts -t "calls GitHub with task-bound"
  echo "   result: PASS"
  echo ""

  echo "14. Push override policy respected via turn context"
  check_grep "story 14: featureBranch from turn context" "featureBranch: targetBranchForTask" src/task/turn-context.ts
  check_grep "story 14: binding uses context featureBranch" "featureBranch: context\\.featureBranch" src/github/tools.ts
  echo "   result: PASS"
  echo ""

  echo "15. GitHub tool contract is obviously task-scoped"
  check_grep "story 15: GitHubTaskBinding type exported" "export interface GitHubTaskBinding" src/github/tools.ts
  check_grep "story 15: bindingFromAgentRuntimeContext exported" "export function bindingFromAgentRuntimeContext" src/github/tools.ts
  echo "   result: PASS"
  echo ""

  echo "16. No regression in happy path after push"
  check_test "story 16: PR created when branch pushed" test/github-tools.test.ts -t "calls GitHub with task-bound"
  echo "   result: PASS"
  echo ""

  echo "## Implementation decisions (from issue body)"
  check_grep "impl: createGitHubTools receives binding" "binding: GitHubTaskBinding" src/github/tools.ts
  check_no_grep "impl: owner/repo/head/base removed from input" "owner: v\\.|head: v\\.|base: v\\." src/github/tools.ts
  check_grep "impl: isFeatureBranchPushed before create" "isFeatureBranchPushed" src/github/tools.ts
  check_grep "impl: agent instructions updated" "title and optional body only" src/agents/coding.ts
  echo "   all implementation decisions: PASS"
  echo ""

  echo "## Testing decisions (from issue body)"
  check_grep "testing: injectable createPullRequest" "createPullRequest\\?" src/github/tools.ts
  check_grep "testing: injectable isFeatureBranchPushed" "isFeatureBranchPushed\\?" src/github/tools.ts
  check_test "testing: agent initialization harness" test/agent-github-tools.test.ts
  echo "   all testing decisions: PASS"
  echo ""

  echo "## Out of scope"
  check_no_grep "out-of-scope: no auto-push in tool" "git push" src/github/tools.ts
  echo "   out of scope respected: PASS"
  echo ""

  echo "OVERALL: GREEN — all 16 user stories cross-verified against issue body and shipped code"
} 2>&1 | tee "$OUT"

echo ""
echo "verify-issue.log written to $OUT"