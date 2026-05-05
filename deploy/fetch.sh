#!/bin/bash
# fetch.sh — Scrape fresh data for a state and hot-reload the local server.
# Usage: ~/fetch.sh mn
#
# No server restart needed. Run this as many times as you want while iterating.
# When data looks right: ~/deploy-data.sh [state]

set -e

STATE=${1:?Usage: fetch.sh <state>    e.g.  fetch.sh mn}

case $STATE in
  mn) DIR="$HOME/mn-lake-fish" ;;
  sd) DIR="$HOME/sd-lake-fish" ;;
  nd) DIR="$HOME/nd-lake-fish" ;;
  ia) DIR="$HOME/ia-lake-fish" ;;
  ne) DIR="$HOME/ne-lake-fish" ;;
  wi) DIR="$HOME/wi-lake-fish" ;;
  mi) DIR="$HOME/mi-lake-fish" ;;
  *)  echo "Unknown state: $STATE (valid: mn sd nd ia ne wi mi)"; exit 1 ;;
esac

echo "▶ fetching $STATE data..."
cd "$DIR" && node fetcher.js

echo ""
echo "▶ reloading local server..."
RESULT=$(curl -sf -X POST "http://localhost:3100/api/$STATE/reload" 2>/dev/null) && \
  echo "  ✓ $RESULT" || \
  echo "  ⚠  server not running — start it with: cd ~/lake-fish-mobile-server && npm run dev"

echo ""
echo "Done. Check the app to verify data looks right."
echo "When ready for production: ~/deploy-data.sh $STATE"
