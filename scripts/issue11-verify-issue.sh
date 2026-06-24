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

{
  echo "Issue #11 acceptance verification"
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Issue body snapshot: $BODY"
  echo ""
  echo "=== Issue body (for audit trail) ==="
  cat "$BODY"
  echo ""
  echo "=== Gate 6: declarative acceptance tests ==="
  echo "\$ npm test -- test/issue11-acceptance.test.ts"
  npm test -- test/issue11-acceptance.test.ts
  echo ""
  echo "OVERALL: GREEN — issue #11 acceptance tests passed"
} 2>&1 | tee "$OUT"

echo ""
echo "verify-issue.log written to $OUT"