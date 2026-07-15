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
  wa) DIR="$HOME/wa-lake-fish" ;;
  mt) DIR="$HOME/mt-lake-fish" ;;
  ks) DIR="$HOME/ks-lake-fish" ;;
  mo) DIR="$HOME/mo-lake-fish" ;;
  il) DIR="$HOME/il-lake-fish" ;;
  oh) DIR="$HOME/oh-lake-fish" ;;
  in) DIR="$HOME/in-lake-fish" ;;
  fl) DIR="$HOME/fl-lake-fish" ;;
  ga) DIR="$HOME/ga-lake-fish" ;;
  al) DIR="$HOME/al-lake-fish" ;;
  tn) DIR="$HOME/tn-lake-fish" ;;
  sc) DIR="$HOME/sc-lake-fish" ;;
  ky) DIR="$HOME/ky-lake-fish" ;;
  va) DIR="$HOME/va-lake-fish" ;;
  *)  echo "Unknown state: $STATE (valid: mn sd nd ia ne wi mi wa mt ks mo il oh in fl ga al tn sc ky va)"; exit 1 ;;
esac

echo "▶ fetching $STATE data..."
cd "$DIR" && node fetcher.js

# MN and ND have a separate stocking pipeline that builds the `stocking`,
# `stocking_progress`, and `lake_stocking_metrics` tables. Skipping this step
# ships a DB missing those tables and causes /results to 500 in production.
if [ -f "$DIR/stock-fetcher.js" ]; then
  echo ""
  echo "▶ fetching $STATE stocking data..."
  node stock-fetcher.js
fi

# MO's survey/catch signal comes from MDC Fishing Prospects prose pages, scraped
# by a second script (same chaining rule as stock-fetcher above).
if [ -f "$DIR/prospects-fetcher.js" ]; then
  echo ""
  echo "▶ fetching $STATE prospects data..."
  node prospects-fetcher.js
fi

# OH's CPUE comes from a Tableau guest bootstrap scrape in a third script.
if [ -f "$DIR/survey-fetcher.js" ]; then
  echo ""
  echo "▶ fetching $STATE survey data..."
  node survey-fetcher.js
fi

# FL/GA's survey signal comes from agency fishing-forecast pages (FWC regional
# forecasts / GA DNR StoryMaps), scraped by a forecast-fetcher (same chaining rule).
if [ -f "$DIR/forecast-fetcher.js" ]; then
  echo ""
  echo "▶ fetching $STATE forecast data..."
  node forecast-fetcher.js
fi

# FL stocking comes from manually-extracted PDF accumulators in
# ~/lakelore-data/accumulators/fl/ — the importer only consumes what's there.
# A NEW stocking year needs a Claude PDF-extraction session first (~/PDF_EXTRACTION.md).
if [ -f "$DIR/import_stocking.js" ]; then
  echo ""
  echo "▶ importing $STATE stocking accumulators..."
  node import_stocking.js
fi

# AL's survey/catch signal comes from manually-extracted BAIT tournament-report
# accumulators in ~/lakelore-data/accumulators/al/ (same rule as FL stocking:
# a NEW year needs a Claude PDF-extraction session first, ~/PDF_EXTRACTION.md).
if [ -f "$DIR/import_bait.js" ]; then
  echo ""
  echo "▶ importing $STATE BAIT accumulators..."
  node import_bait.js
fi

# SC's survey signal is species presence decoded from the SCDNR access-site layer.
if [ -f "$DIR/species-fetcher.js" ]; then
  echo ""
  echo "▶ fetching $STATE species-presence data..."
  node species-fetcher.js
fi

# KY's survey signal comes from manually-extracted Fishing Forecast star-rating
# accumulators in ~/lakelore-data/accumulators/ky/ (a NEW edition needs a Claude
# PDF-extraction session first, ~/PDF_EXTRACTION.md).
if [ -f "$DIR/import_forecast.js" ]; then
  echo ""
  echo "▶ importing $STATE forecast accumulators..."
  node import_forecast.js
fi

# KY also carries a REAL-CPUE overlay from the annual Lake & Tailwater Survey PDF
# (accumulators/ky/ky_survey_<year>_part*.json), loaded as a second gear stream.
if [ -f "$DIR/import_surveys.js" ]; then
  echo ""
  echo "▶ importing $STATE survey CPUE accumulators..."
  node import_surveys.js
fi

echo ""
echo "▶ reloading local server..."
RESULT=$(curl -sf -X POST "http://localhost:3100/api/$STATE/reload" 2>/dev/null) && \
  echo "  ✓ $RESULT" || \
  echo "  ⚠  server not running — start it with: cd ~/lake-fish-mobile-server && npm run dev"

echo ""
echo "Done. Check the app to verify data looks right."
echo "When ready for production: ~/deploy-data.sh $STATE"
