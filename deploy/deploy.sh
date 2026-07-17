#!/bin/bash
# deploy.sh — test-gated server image deploy (IMPROVEMENT_PLAN_2026-07-17 B5).
#
# Bare `flyctl deploy` shipped whatever was in the working tree with zero
# checks — a server.js edit that 500s a non-MN state sailed straight to
# production (the uptime probe samples only mn/tx). This wrapper makes the
# already-written test suite un-skippable:
#
#   1. test/smoke.js — every active state's endpoints against local artifacts
#      (incl. preview-redaction assertions).
#   2. Parity spot-replay (mn tx ga) — the serving path must stay
#      byte-identical to the golden corpus. A DELIBERATE wire change fails
#      here by design: re-record the goldens first (bin/parity.js --record),
#      which is exactly the review step the gate exists to force.
#   3. flyctl deploy from ~ (the Docker build context).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
FLY="${FLY:-$HOME/.fly/bin/flyctl}"

echo "== 1/3 server smoke tests =="
(cd "$DIR" && npm test)

echo "== 2/3 parity spot-replay (mn tx ga) =="
for st in mn tx ga; do
  if node "$HOME/lakelore-data/bin/parity.js" "$st" --replay "$HOME/lakelore-data/golden/$st/" > /tmp/parity-$st.log 2>&1; then
    echo "parity $st PASS"
  else
    tail -5 "/tmp/parity-$st.log"
    echo "parity $st FAIL — aborting deploy. Intentional wire change? Re-record goldens first."
    exit 1
  fi
done

echo "== 3/3 flyctl deploy =="
cd "$HOME"
exec "$FLY" deploy --config "$DIR/deploy/fly.toml"
