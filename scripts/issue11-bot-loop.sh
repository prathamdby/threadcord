#!/usr/bin/env bash
set -euo pipefail

PR="${1:?usage: $0 <pr-number>}"
SLEEP="${ISSUE11_BOT_SLEEP:-120}"
MAX="${ISSUE11_BOT_MAX:-30}"

current_head_sha() {
  gh pr view "$PR" --json headRefOid --jq .headRefOid
}

count_zeus_findings() {
  local body head
  head=$(current_head_sha)
  body=$(gh api "repos/{owner}/{repo}/pulls/${PR}/reviews" --paginate \
    --jq '[.[] | select(.user.login == "zeus-review[bot]") | .body] | last // ""')
  if [[ -z "$body" || "$body" == *"Review in progress"* ]]; then
    echo "pending"
    return
  fi
  if [[ "$body" == *"No issues"* ]]; then
    echo 0
    return
  fi
  gh api "repos/{owner}/{repo}/pulls/${PR}/comments" \
    --jq "[.[] | select(.user.login == \"zeus-review[bot]\") | select(.commit_id == \"${head}\")] | length"
}

count_gemini_findings() {
  local head
  head=$(current_head_sha)
  gh api "repos/{owner}/{repo}/pulls/${PR}/comments" \
    --jq "[.[] | select(.user.login == \"gemini-code-assist[bot]\") | select(.commit_id == \"${head}\")] | length"
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
