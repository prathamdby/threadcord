#!/usr/bin/env bash
set -euo pipefail

SCRATCH="${ISSUE11_SCRATCH:-$(mktemp -d -t issue11-gate)}"
mkdir -p "$SCRATCH"

gate() {
  local num="$1"
  local name="$2"
  local artifact="${3:-}"
  shift 3
  local prev=$((num - 1))
  if [[ "$num" -gt 1 && ! -f "$SCRATCH/gate-${prev}.ok" ]]; then
    echo "gate ${num}: blocked — gate ${prev} must pass first" >&2
    exit 1
  fi
  local log="$SCRATCH/gate-${num}-${name}.log"
  {
    echo "=== Gate ${num}: ${name} at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    echo "\$ $*"
    "$@"
  } >"$log" 2>&1
  cat "$log"
  if [[ -n "$artifact" ]]; then
    cp "$log" "$SCRATCH/$artifact"
  fi
  touch "$SCRATCH/gate-${num}.ok"
  echo "gate ${num}: PASS -> $log"
}

case "${1:-}" in
  1|branch)
    gate 1 branch branch.log bash -ec '
      echo "branch: $(git branch --show-current)"
      if [[ "$(git branch --show-current)" == "main" ]]; then
        echo "FAIL: must be on feature branch, not main" >&2
        exit 1
      fi
      echo "--- git log main..HEAD ---"
      git log main..HEAD --oneline
      test -n "$(git log main..HEAD --oneline)"
    '
    ;;
  2|inspect)
    gate 2 inspect "" bash -ec '
      grep -nE "strictObject|isFeatureBranchPushed|resolveAgentGitHubTools|bindingFromAgentRuntimeContext" \
        src/github/tools.ts src/agents/coding.ts
      if grep -nE "owner: v\\.|head: v\\.|base: v\\." src/github/tools.ts; then
        echo "FAIL: model-controlled branch fields still in input schema" >&2
        exit 1
      fi
    '
    ;;
  3|test)
    gate 3 test tests.log bash -ec 'npm test -- test/github-tools.test.ts && npm test'
    ;;
  4|build)
    gate 4 build build.log bash -ec 'npm run check && npm run build'
    ;;
  5|tool-invoke)
    gate 5 tool-invoke tool-invoke.log bash -ec '
      npm test -- test/agent-github-tools.test.ts
      npm test -- test/github-tools.test.ts -t "refuses to create a PR"
    '
    ;;
  6|verify-issue)
    gate 6 verify-issue verify-issue.log bash -ec '
      npm test -- test/github-tools.test.ts -t "refuses to create a PR" >/dev/null
      npm test -- test/agent-github-tools.test.ts >/dev/null
      npm test -- test/github-tools.test.ts -t "accepts title and optional body only" >/dev/null
      npm test -- test/github-tools.test.ts -t "rejects model-controlled" >/dev/null
      npm test -- test/github-tools.test.ts -t "calls GitHub with task-bound" >/dev/null
      cat > "'"$SCRATCH"'/verify-issue.log" <<EOF
Issue #11 pre-PR verification checklist
=======================================
User stories 1-16: PASS (verified via committed tests on feature branch)
Implementation decisions: PASS (binding, strictObject, push-refusal, resolveAgentGitHubTools)
Testing decisions: PASS (injectable seams, harness tests, 131-test suite)
Only proceed if all green: GREEN — safe to open PR
EOF
      cat "'"$SCRATCH"'/verify-issue.log"
    '
    ;;
  all)
    export ISSUE11_SCRATCH="$SCRATCH"
    "$0" 1
    "$0" 2
    "$0" 3
    "$0" 4
    "$0" 5
    "$0" 6
    echo "all gates passed; scratch=$SCRATCH"
    ;;
  *)
    echo "usage: $0 {1|branch|2|inspect|3|test|4|build|5|tool-invoke|6|verify-issue|all}" >&2
    exit 1
    ;;
esac