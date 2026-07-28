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

# ── 0/4 Provenance gate (2026-07-28) ─────────────────────────────────────────
# Deploys ship the WORKING TREE (build context ~/, which COPYs this repo AND
# lakelore-data's registry/species/schema/survival). A dirty or unpushed tree
# means production runs code no commit describes — unbisectable, unreviewable,
# and invisible to CI. Refuse both repos unless explicitly overridden:
#   DEPLOY_ALLOW_DIRTY=1 ./deploy/deploy.sh   # emergencies only; say why in the incident note
if [[ "${DEPLOY_ALLOW_DIRTY:-0}" != "1" ]]; then
  for repo in "$DIR" "$HOME/lakelore-data"; do
    name="$(basename "$repo")"
    if [[ -n "$(git -C "$repo" status --porcelain)" ]]; then
      echo "❌ $name has uncommitted changes — commit (or DEPLOY_ALLOW_DIRTY=1 for an emergency):"
      git -C "$repo" status --short | head -10
      exit 1
    fi
    branch="$(git -C "$repo" symbolic-ref -q --short HEAD || echo '?')"
    if [[ -n "$(git -C "$repo" log "origin/$branch..HEAD" --oneline 2>/dev/null | head -1)" ]]; then
      echo "❌ $name has unpushed commits on $branch — push first so the deploy is reproducible:"
      git -C "$repo" log "origin/$branch..HEAD" --oneline | head -5
      exit 1
    fi
  done
  echo "provenance: both repos clean + pushed"
fi

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

echo "== 3/4 flyctl deploy =="
cd "$HOME"
"$FLY" deploy --config "$DIR/deploy/fly.toml"

# ── 4/4 Post-deploy readiness gate (2026-07-25, T3.1) ────────────────────────
# Fly's own check is the unconditional /healthz — a code deploy that 500s
# every state's data path used to pass it and only surface via the 15-min
# uptime probe. Reuse deploy-data.sh's gate: LB /readyz, then per-machine
# ?deep=1 (a real query per state), plus the client-config endpoint.
APP=$(sed -n "s/^app = ['\"]\(.*\)['\"]$/\1/p" "$DIR/deploy/fly.toml" | head -1)
[ -n "$APP" ] || APP="lake-fish-api"
echo "== 4/4 post-deploy readiness gate =="
READY_LB=0
for i in $(seq 1 30); do
  BODY=$(curl -s --max-time 10 "https://$APP.fly.dev/readyz" || true)
  if echo "$BODY" | grep -q '"ready":true'; then
    echo "READY (LB): $BODY"; READY_LB=1; break
  fi
  sleep 5
done
if [ "$READY_LB" -eq 0 ]; then
  echo "❌ NOT READY after 150s: ${BODY:-no response}"
  echo "   ROLL BACK: $FLY releases --app $APP   → then"
  echo "             $FLY deploy --app $APP --image <previous image ref>"
  echo "   (~/RUNBOOK.md §2)"
  exit 1
fi

MACHINE_ROWS=$("$FLY" machine list --app "$APP" --json \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).map(m=>m.id+':'+m.state).join(' '))}catch(e){process.exit(1)}})") || true
# Empty enumeration = INCONCLUSIVE gate, never a vacuous pass (bug-hunt #2).
[ -n "$MACHINE_ROWS" ] || { echo "❌ could not enumerate machines — gate INCONCLUSIVE, treat as failed"; exit 1; }
DEEP_FAIL=0
for row in $MACHINE_ROWS; do
  mid="${row%%:*}"
  DEEP=$("$FLY" ssh console --app "$APP" --machine "$mid" \
    -C "node -e \"fetch('http://localhost:3100/readyz?deep=1').then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))\"" 2>/dev/null || true)
  if [ -z "$DEEP" ]; then
    "$FLY" machine start "$mid" --app "$APP" >/dev/null 2>&1 || true
    sleep 10
    DEEP=$("$FLY" ssh console --app "$APP" --machine "$mid" \
      -C "node -e \"fetch('http://localhost:3100/readyz?deep=1').then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))\"" 2>/dev/null || true)
  fi
  if echo "$DEEP" | grep -q '"ready":true'; then
    echo "READY (deep, $mid)"
  else
    echo "❌ machine $mid deep check failed: ${DEEP:-no response}"; DEEP_FAIL=1
  fi
done
CFG=$(curl -s --max-time 10 "https://$APP.fly.dev/api/client-config" || true)
echo "client-config: ${CFG:-no response}"
echo "$CFG" | grep -q 'killedVersions' || { echo "❌ /api/client-config not serving"; DEEP_FAIL=1; }
if [ "$DEEP_FAIL" -eq 1 ]; then
  echo "   ROLL BACK: $FLY releases --app $APP → $FLY deploy --app $APP --image <previous image ref> (~/RUNBOOK.md §2)"
  exit 1
fi
echo "deploy verified: LB ready, all machines deep-ready, client-config serving"
