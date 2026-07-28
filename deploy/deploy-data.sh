#!/bin/bash
# deploy-data.sh — Upload fresh state databases to the Fly.io volume and restart.
# Lakelore app — run from the project root (/Users/andrewtop/).
#
# Usage:
#   ./deploy-data.sh                 # drift check + upload all states
#   ./deploy-data.sh mn              # upload only MN (after drift check)
#   ./deploy-data.sh mn sd           # upload MN and SD (after drift check)
#   ./deploy-data.sh --check         # drift check only, no upload
#   ./deploy-data.sh --check mn      # drift check for MN only
#   ./deploy-data.sh --force mn      # upload MN even if local is BEHIND prod
#
# By default the drift check aborts before upload if local row counts are
# LESS than production for any key table — that pattern almost always means
# you're about to ship a stale snapshot and clobber production data.
# `--force` overrides. Drift where local is AHEAD of prod is the normal
# "I scraped new data, ship it" case and proceeds without prompting.

set -e

APP="lake-fish-api"
FLY="$HOME/.fly/bin/fly"
# $0 is usually invoked via the ~/deploy-data.sh symlink, so plain dirname
# points at $HOME. Resolve the real path so the sibling helper is found.
SCRIPT_DIR="$(python3 -c "import os.path,sys; print(os.path.dirname(os.path.realpath(sys.argv[1])))" "$0")"
DRIFT_CHECK="$SCRIPT_DIR/_drift_check.py"

# ── Parse flags ───────────────────────────────────────────────────────────
CHECK_ONLY=0
FORCE=0
NO_RESTART=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    --no-restart) NO_RESTART=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *)  POSITIONAL+=("$arg") ;;
  esac
done

if [ ${#POSITIONAL[@]} -eq 0 ]; then
  STATE_ARG="all"
else
  STATE_ARG="${POSITIONAL[*]}"
fi

# ── Drift check ───────────────────────────────────────────────────────────
# Runs first so it can short-circuit a bad upload. Exits 2 when local is
# behind prod somewhere; we honor that unless --force is set. Always print
# the table whether or not we proceed.
set +e
python3 "$DRIFT_CHECK" "${POSITIONAL[@]}"
DRIFT_RC=$?
set -e

if [ "$CHECK_ONLY" -eq 1 ]; then
  exit "$DRIFT_RC"
fi

if [ "$DRIFT_RC" -eq 2 ] && [ "$FORCE" -eq 0 ]; then
  echo
  echo "Aborting upload. Re-run with --force if you really mean to do this."
  exit 2
fi

if [ "$DRIFT_RC" -ne 0 ] && [ "$DRIFT_RC" -ne 2 ]; then
  echo
  echo "Drift check errored (rc=$DRIFT_RC). Aborting to be safe."
  exit "$DRIFT_RC"
fi

# ── Upload ────────────────────────────────────────────────────────────────
# Multi-machine (RUNBOOK §14, 2026-07-16): each machine has its own volume, so
# every upload runs once PER MACHINE via --machine. With one machine this is
# identical to the old behavior.
MACHINE_ROWS=$("$FLY" machine list --app "$APP" --json 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).map(m=>m.id+':'+m.state).join(' '))}catch(e){process.exit(1)}})")
if [ -z "$MACHINE_ROWS" ]; then
  echo "❌ could not enumerate machines"; exit 1
fi
# Wake auto-stopped machines first (2026-07-17): sftp/ssh to a stopped machine
# errors "not found/started", which used to abort the whole upload on the
# first state. auto_stop re-stops them after idle.
MACHINE_IDS=""
for row in $MACHINE_ROWS; do
  mid="${row%%:*}"; mstate="${row##*:}"
  if [ "$mstate" != "started" ]; then
    echo "waking $mstate machine $mid"
    "$FLY" machine start "$mid" --app "$APP" >/dev/null 2>&1 || true
    sleep 10
  fi
  MACHINE_IDS="$MACHINE_IDS $mid"
done
echo "machines:$MACHINE_IDS"

# A machine can AUTO-STOP mid-run (ssh/sftp sessions don't count as LB
# activity — a fleet-wide upload takes long enough to hit the idle stop, which
# aborted the 2026-07-17 v6 upload halfway). wake() + retry on every remote op.
wake() {
  "$FLY" machine start "$1" --app "$APP" >/dev/null 2>&1 || true
  sleep 10
}
upload() {
  local src="$1" dest="$2" state="$3"
  if [[ "$STATE_ARG" == "all" ]] || [[ " $STATE_ARG " == *" $state "* ]]; then
    if [ -f "$src" ]; then
      # Merge any pending WAL into the .db file before uploading. Without this
      # the upload may ship a stale snapshot that lacks recent writes still
      # sitting in lakes.db-wal — burned us once on the MI county backfill.
      sqlite3 "$src" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
      for mid in $MACHINE_IDS; do
        # Atomic swap (2026-07-17, B11): upload to <dest>.new and mv into
        # place. The old rm-then-put left the live path MISSING for the whole
        # transfer — an auto-started machine mid-upload 503'd that state.
        "$FLY" ssh console --app "$APP" --machine "$mid" -C "rm -f ${dest}.new" >/dev/null 2>&1 || true
        echo "→ uploading $state -> $mid: $src"
        if ! "$FLY" sftp put "$src" "${dest}.new" --app "$APP" --machine "$mid"; then
          echo "   retrying after wake ($mid)"
          wake "$mid"
          "$FLY" sftp put "$src" "${dest}.new" --app "$APP" --machine "$mid"
        fi
        if ! "$FLY" ssh console --app "$APP" --machine "$mid" -C "sh -c 'rm -f ${dest}-shm ${dest}-wal && mv -f ${dest}.new ${dest}'"; then
          wake "$mid"
          "$FLY" ssh console --app "$APP" --machine "$mid" -C "sh -c 'rm -f ${dest}-shm ${dest}-wal && mv -f ${dest}.new ${dest}'"
        fi
      done
    else
      echo "⚠  $state: source file not found ($src), skipping"
    fi
  fi
}

# Source selection: states flagged canonical in the lakelore-data registry
# upload their canonical artifact (lakelore-data/out/<state>.db — built by
# normalize.js behind validation gates); everything else uploads the legacy
# raw scraper DB. _drift_check.py uses the same rule, so the drift comparison
# always matches what actually ships.
src_for() {
  local state="$1" legacy="$2"
  local canon="$HOME/lakelore-data/out/${state}.db"
  local reg="$HOME/lakelore-data/registry/states.json"
  if [ -f "$canon" ] && [ -f "$reg" ] && \
     python3 -c "import json,sys; sys.exit(0 if json.load(open('$reg'))['states'].get('$state',{}).get('canonical') else 1)"; then
    echo "$canon"
  else
    echo "$legacy"
  fi
}

# Registry-driven state list (2026-07-15, all-states launch): every state in
# lakelore-data/registry/states.json ships its canonical artifact. The legacy
# raw-DB fallbacks survive for the original seven in case a canonical artifact
# is missing locally (src_for prefers canonical whenever it exists).
legacy_src() {
  case "$1" in
    mn) echo "mn-lake-fish/data/lakes.db" ;;
    sd) echo "sd-lake-fish/data/sd_lakes.db" ;;
    nd) echo "nd-lake-fish/data/lakes.db" ;;
    ia) echo "ia-lake-fish/data/lakes.db" ;;
    ne) echo "ne-lake-fish/data/lakes.db" ;;
    wi) echo "wi-lake-fish/data/lakes.db" ;;
    mi) echo "mi-lake-fish/data/lakes.db" ;;
    *)  echo "" ;;
  esac
}

ALL_REGISTRY_STATES=$(python3 -c "import json,os; print(' '.join(json.load(open(os.path.expanduser('~/lakelore-data/registry/states.json')))['states'].keys()))")
for st in $ALL_REGISTRY_STATES; do
  upload "$(src_for "$st" "$(legacy_src "$st")")" "/data/$st.db" "$st"
done

if [ "$NO_RESTART" -eq 1 ]; then
  # Schema-bump mode (2026-07-17): upload only, no restart. Running processes
  # keep serving via their already-open handles; the follow-up IMAGE deploy
  # (new canonical.sql riding the image) restarts machines onto the new DBs,
  # so schema assert never sees a mixed image/data vintage. Follow with
  # deploy/deploy.sh immediately.
  echo ""
  echo "--no-restart: uploads done. Deploy the matching image NOW (deploy/deploy.sh)."
  exit 0
fi

echo ""
echo "Restarting app to load new databases..."
"$FLY" app restart "$APP"

# Post-restart readiness gate (IMPROVEMENT_PLAN 1.10): /readyz is 200 only
# when EVERY active state serves with a valid schema — a corrupt/missing/
# schema-drifted DB upload fails HERE instead of as user-facing 500s.
echo ""
echo "Waiting for /readyz..."
READY_LB=0
for i in $(seq 1 30); do
  BODY=$(curl -s --max-time 10 "https://$APP.fly.dev/readyz" || true)
  if echo "$BODY" | grep -q '"ready":true'; then
    echo "READY (LB): $BODY"
    READY_LB=1
    break
  fi
  sleep 5
done
if [ "$READY_LB" -eq 0 ]; then
  echo "❌ NOT READY after 150s: $BODY"
  echo "   Per-state detail: curl -H \"Authorization: Bearer \$(cat ~/.lakelore_reload_token)\" 'https://$APP.fly.dev/healthz?deep=1'"
  echo "   Roll back by re-uploading the previous artifact (B2 backup) or"
  echo "   'fly image rollback' if the image changed too (~/RUNBOOK.md)."
  exit 1
fi

# Per-machine DEEP readiness (2026-07-17, B6): the LB poll above can be
# satisfied entirely by ONE machine (the other may be auto-stopped or serving
# a diverged vintage), and shallow /readyz never executes a query. Hit every
# machine directly over localhost with ?deep=1, which runs a real SELECT per
# state — catches per-machine corruption and split uploads.
DEEP_FAIL=0
for mid in $MACHINE_IDS; do
  DEEP=$("$FLY" ssh console --app "$APP" --machine "$mid" \
    -C "node -e \"fetch('http://localhost:3100/readyz?deep=1').then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))\"" 2>/dev/null || true)
  if [ -z "$DEEP" ]; then
    # Machine may have auto-stopped since the restart — wake it and retry once.
    "$FLY" machine start "$mid" --app "$APP" >/dev/null 2>&1 || true
    sleep 10
    DEEP=$("$FLY" ssh console --app "$APP" --machine "$mid" \
      -C "node -e \"fetch('http://localhost:3100/readyz?deep=1').then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))\"" 2>/dev/null || true)
  fi
  if echo "$DEEP" | grep -q '"ready":true'; then
    echo "READY (deep, $mid): $DEEP"
  else
    echo "❌ machine $mid deep check failed: ${DEEP:-no response}"
    DEEP_FAIL=1
  fi
done
if [ "$DEEP_FAIL" -eq 1 ]; then
  echo "   One or more machines are unhealthy or diverged — see above."
  echo "   Re-run this deploy (uploads are atomic) or roll back (~/RUNBOOK.md)."
  exit 1
fi
exit 0
