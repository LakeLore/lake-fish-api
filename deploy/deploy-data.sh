#!/bin/bash
# deploy-data.sh — Upload fresh state databases to the Fly.io volume and restart.
# Lakelore app — run from the project root (/Users/andrewtop/).
#
# Usage:
#   ./deploy-data.sh           # upload all states
#   ./deploy-data.sh mn        # upload only MN
#   ./deploy-data.sh mn sd     # upload MN and SD

set -e

APP="lake-fish-api"
STATE_ARG="${@:-all}"
FLY="$HOME/.fly/bin/fly"

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

upload "mn-lake-fish/data/lakes.db"      "/data/mn.db" "mn"
upload "sd-lake-fish/data/sd_lakes.db"   "/data/sd.db" "sd"
upload "nd-lake-fish/data/lakes.db"      "/data/nd.db" "nd"
upload "ia-lake-fish/data/lakes.db"      "/data/ia.db" "ia"
upload "ne-lake-fish/data/lakes.db"      "/data/ne.db" "ne"
upload "wi-lake-fish/data/lakes.db"      "/data/wi.db" "wi"
upload "mi-lake-fish/data/lakes.db"      "/data/mi.db" "mi"

echo ""
echo "Restarting app to load new databases..."
"$FLY" app restart "$APP"
echo ""
echo "Done. Verify:"
echo "  curl https://$APP.fly.dev/api/mn/status"
