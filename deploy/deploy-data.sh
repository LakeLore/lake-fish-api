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
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
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
upload() {
  local src="$1" dest="$2" state="$3"
  if [[ "$STATE_ARG" == "all" ]] || [[ " $STATE_ARG " == *" $state "* ]]; then
    if [ -f "$src" ]; then
      # Merge any pending WAL into the .db file before uploading. Without this
      # the upload may ship a stale snapshot that lacks recent writes still
      # sitting in lakes.db-wal — burned us once on the MI county backfill.
      sqlite3 "$src" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
      # fly sftp put refuses to overwrite, so clear the destination first
      # (along with any sibling -shm/-wal files left from the previous deploy).
      "$FLY" ssh console --app "$APP" -C "rm -f $dest ${dest}-shm ${dest}-wal" >/dev/null 2>&1 || true
      echo "→ uploading $state: $src"
      "$FLY" sftp put "$src" "$dest" --app "$APP"
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

echo ""
echo "Restarting app to load new databases..."
"$FLY" app restart "$APP"
echo ""
echo "Done. Verify:"
echo "  curl https://$APP.fly.dev/api/mn/status"
