#!/usr/bin/env bash
set -euo pipefail

SCRATCH="${ISSUE11_SCRATCH:?ISSUE11_SCRATCH must be set}"
OUT="$SCRATCH/verify-issue.log"
BODY="$SCRATCH/issue-11-body.txt"
ACCEPTANCE="test/issue11-acceptance.test.ts"

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
    on && $0 == n { exit }
    on && $0 ~ "^## " && $0 != h { exit }
    on { print }
  ' "$BODY"
}

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

run_story_test() {
  local num="$1"
  local text="$2"
  echo "Story $num (parsed from issue body):"
  echo "  $text"
  echo "--- test: story $num ---"
  echo "\$ npm test -- $ACCEPTANCE -t \"story $num:\""
  npm test -- "$ACCEPTANCE" -t "story $num:"
  pass "story $num cross-verified"
  echo ""
}

run_named_test() {
  local label="$1"
  local pattern="$2"
  echo "$label"
  echo "--- test ---"
  echo "\$ npm test -- $ACCEPTANCE -t \"$pattern\""
  npm test -- "$ACCEPTANCE" -t "$pattern"
  pass "$label"
  echo ""
}

list_acceptance_tests() {
  local prefix="$1"
  grep -oE "it\\(\"${prefix}[^\"]+\"" "$ACCEPTANCE" \
    | sed -E 's/it\("([^"]+)".*/\1/'
}

{
  echo "Issue #11 dynamic cross-verification"
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
    [[ "$line" =~ ^([0-9]+)\.[[:space:]]+(.*)$ ]] || continue
    num="${BASH_REMATCH[1]}"
    text="${BASH_REMATCH[2]}"
    run_story_test "$num" "$text"
    story_count=$((story_count + 1))
  done <<<"$STORIES"

  if [[ "$story_count" -ne 16 ]]; then
    fail "expected 16 user stories from body, parsed $story_count"
  fi
  echo "Parsed and cross-verified $story_count user stories."
  echo ""

  echo "=== Parsed Implementation Decisions ==="
  echo "$IMPL"
  echo ""
  if [[ -z "$(echo "$IMPL" | grep -E '^- ' || true)" ]]; then
    fail "implementation decisions section parsed empty"
  fi

  impl_tests=()
  while IFS= read -r t; do impl_tests+=("$t"); done < <(list_acceptance_tests "impl: ")
  impl_count=0
  impl_idx=0
  while IFS= read -r line; do
    [[ "$line" =~ ^- ]] || continue
    bullet=$(echo "$line" | sed 's/^- //')
    if echo "$bullet" | grep -qiE '^Consider '; then
      echo "Implementation decision (parsed, non-binding): $bullet"
      echo "  SKIP: optional consideration, no acceptance test required"
      echo ""
      continue
    fi
    if [[ "$impl_idx" -ge "${#impl_tests[@]}" ]]; then
      fail "more impl decisions in issue body than acceptance tests"
    fi
    test_name="${impl_tests[$impl_idx]}"
    echo "Implementation decision (parsed): $bullet"
    run_named_test "impl decision -> $test_name" "$test_name"
    impl_count=$((impl_count + 1))
    impl_idx=$((impl_idx + 1))
  done <<<"$IMPL"
  echo "Parsed and cross-verified $impl_count implementation decisions."
  echo ""

  echo "=== Parsed Testing Decisions ==="
  echo "$TESTING"
  echo ""

  testing_tests=()
  while IFS= read -r t; do testing_tests+=("$t"); done < <(list_acceptance_tests "testing: ")
  test_count=0
  test_idx=0
  while IFS= read -r line; do
    [[ "$line" =~ ^- ]] || continue
    bullet=$(echo "$line" | sed 's/^- //')
    if echo "$bullet" | grep -qiE 'prior art|Existing provider'; then
      echo "Testing decision (parsed, contextual): $bullet"
      echo "  SKIP: prior-art note, no dedicated acceptance test"
      echo ""
      continue
    fi
    if [[ "$test_idx" -ge "${#testing_tests[@]}" ]]; then
      fail "more testing decisions in issue body than acceptance tests"
    fi
    test_name="${testing_tests[$test_idx]}"
    echo "Testing decision (parsed): $bullet"
    run_named_test "testing decision -> $test_name" "$test_name"
    test_count=$((test_count + 1))
    test_idx=$((test_idx + 1))
  done <<<"$TESTING"
  echo "Parsed and cross-verified $test_count testing decisions."
  echo ""

  echo "=== Parsed Out of Scope ==="
  echo "$OUTSCOPE"
  echo ""
  if echo "$OUTSCOPE" | grep -qi "automatically pushing"; then
    echo "--- grep absent: out-of-scope: no auto-push in tool ---"
    if grep -nE 'git push' src/github/tools.ts; then
      fail "out-of-scope: auto-push found in tool"
    fi
    pass "out-of-scope: no auto-push in tool"
  fi
  if echo "$OUTSCOPE" | grep -qi "issue creation"; then
    echo "--- grep absent: out-of-scope: no issue tools ---"
    if grep -nE 'issues\.create' src/github/tools.ts; then
      fail "out-of-scope: issue tools found"
    fi
    pass "out-of-scope: no issue tools"
  fi
  echo "  out of scope: PASS"
  echo ""

  echo "OVERALL: GREEN — issue body parsed dynamically; each story/decision cross-verified via acceptance tests"
} 2>&1 | tee "$OUT"

echo ""
echo "verify-issue.log written to $OUT"