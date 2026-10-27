#!/usr/bin/env bash
# Exempt a test device from the per-subscriber Ask LakeLore daily cap.
#
#   bin/set-ask-unlimited.sh <first-8-chars-of-user-id> [more prefixes…]
#
# Finds each device's full app user id in the Ask logs on the production
# volumes (a device appears there once it has asked at least one question),
# then writes the whole list to the LAKELORE_ASK_UNLIMITED_USERS secret.
# The full ids are never printed: they are the paid credential. Setting the
# secret restarts the machines (about a minute). RUNBOOK §20.
set -euo pipefail
FLY="${FLY:-$HOME/.fly/bin/flyctl}"
APP="${APP:-lake-fish-api}"
[[ $# -ge 1 ]] || { echo "usage: $0 <id-prefix> [id-prefix…]" >&2; exit 2; }

machines=$("$FLY" machine list --app "$APP" --json | python3 -c 'import json,sys; print(" ".join(m["id"] for m in json.load(sys.stdin)))')
ids=()
for prefix in "$@"; do
  [[ "$prefix" =~ ^[0-9a-f-]{8,}$ ]] || { echo "not an id prefix: $prefix" >&2; exit 2; }
  found=""
  for m in $machines; do
    # Machine-targeted ssh doesn't wake a stopped machine; start it first.
    "$FLY" machine start "$m" --app "$APP" >/dev/null 2>&1 || true
    out=$("$FLY" ssh console --app "$APP" --machine "$m" \
      -C "sh -c 'grep -ohE \"${prefix}[0-9a-f-]+\" /data/ask-*.jsonl 2>/dev/null | sort -u'" 2>/dev/null || true)
    found=$(printf '%s\n%s\n' "$found" "$out" | grep -E '^[0-9a-f-]{36}$' | grep -F -- "$prefix" | grep -E "^${prefix}" | sort -u || true)
  done
  n=$(printf '%s' "$found" | grep -c . || true)
  if [[ "$n" -ne 1 ]]; then
    echo "prefix ${prefix}: found $n matching ids in the Ask logs — need exactly 1. Ask one question from that device, then rerun." >&2
    exit 1
  fi
  echo "prefix ${prefix}: found the full id (${#found} chars)"
  ids+=("$found")
done

list=$(IFS=,; echo "${ids[*]}")
"$FLY" secrets set "LAKELORE_ASK_UNLIMITED_USERS=$list" --app "$APP" >/dev/null
echo "LAKELORE_ASK_UNLIMITED_USERS set with ${#ids[@]} id(s); machines are restarting."
echo "Check: $FLY logs --app $APP --no-tail | grep 'ask] limits'  → 'unlimited users ${#ids[@]}'"
