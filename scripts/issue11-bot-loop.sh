#!/usr/bin/env bash
set -euo pipefail

PR="${1:?usage: $0 <pr-number>}"
SLEEP="${ISSUE11_BOT_SLEEP:-120}"
MAX="${ISSUE11_BOT_MAX:-30}"

count_zeus_findings() {
  local body
  body=$(gh api "repos/{owner}/{repo}/issues/${PR}/comments" --paginate \
    --jq '[.[] | select(.user.login == "zeus-review[bot]") | .body] | last // ""')
  if [[ -z "$body" || "$body" == *"Review in progress"* ]]; then
    echo "pending"
    return
  fi
  if [[ "$body" == *"No issues"* ]]; then
    echo 0
    return
  fi
  (grep -oE 'P[12] ·' <<<"$body" || true) | wc -l | tr -d ' '
}

count_gemini_findings() {
  local inline
  inline=$(gh api "repos/{owner}/{repo}/pulls/${PR}/comments" --paginate \
    --jq '[.[] | select(.user.login == "gemini-code-assist[bot]")] | length')
  echo "$inline"
}

ci_clean() {
  local test_state docker_state
  test_state=$(gh pr checks "$PR" --json name,state --jq \
    '[.[] | select(.name == "test") | .state] | first // "MISSING"')
  docker_state=$(gh pr checks "$PR" --json name,state --jq \
    '[.[] | select(.name == "docker") | .state] | first // "MISSING"')
  [[ "$test_state" == "SUCCESS" && "$docker_state" == "SUCCESS" ]]
}

iteration=0
while [[ "$iteration" -lt "$MAX" ]]; do
  iteration=$((iteration + 1))
  echo "=== bot loop iteration $iteration at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo "sleeping ${SLEEP}s..."
  sleep "$SLEEP"

  echo "--- CI checks ---"
  gh pr checks "$PR" 2>&1 || true

  zeus=$(count_zeus_findings)
  gemini=$(count_gemini_findings)
  echo "Zeus: $zeus"
  echo "Gemini: $gemini"
  echo "CI test/docker clean: $(ci_clean && echo yes || echo no)"

  if [[ "$zeus" == "pending" ]]; then
    echo "bot loop: waiting for Zeus review"
    continue
  fi

  if ci_clean && [[ "$zeus" -eq 0 && "$gemini" -eq 0 ]]; then
    echo "bot loop: CLEAN — CI green, Zeus 0, Gemini 0"
    exit 0
  fi

  echo "bot loop: not clean yet (zeus=$zeus gemini=$gemini)"
done

echo "bot loop: FAILED after $MAX iterations" >&2
exit 1