# lake-fish-api

*Last reconciled with code: 2026-07-17.*

The unified Express + SQLite API server behind the **LakeLore** mobile app and marketing site, deployed to Fly.io as `lake-fish-api` (https://lake-fish-api.fly.dev).

Serves the active states at `/api/{state}/{status|filters|results|lake/:id}` plus a `/healthz` and a token-protected `/api/:state/reload`. **The active set is 38 registry states — 38 US states; MB product-held 2026-08-13 (US-only submission; licence-clean) — after the 2026-08-04 legal holds (AB BC ON SK AK HI KS KY MI NE VT `active:false` per `~/DATA_LICENSING_AUDIT_2026-07-28.md`; owner policy: any compliance violation holds the whole state). SC/AZ/MA/DE/RI/QC additionally stay `active:false` for product reasons.** `ACTIVE_STATES` is derived at startup from `active: true` flags in `~/lakelore-data/registry/states.json` (the authoritative registry; no hand-mirrored literal anymore). Every active state is canonical and serves from `LAKELORE_DB_DIR/{state}.db` (`/data` in production; a per-state `{STATE}_DB_PATH` env still overrides). The registry `country` field (`"CA"`) distinguishes Canadian provinces. `LAKELORE_ACTIVE_STATES_EXTRA` remains as a dev affordance for smoke-testing a state not yet flagged active (never set in production).

## Layout

```
lake-fish-mobile-server/
  server.js            — the API (single-file Express server, ~800 lines)
  entitlement.js       — RC v2 entitlement gate + cache (preview-mode middleware)
  server/
    canonical.js       — generic registry-driven filters/results/lake handlers
    attest.js          — App Attest / Play Integrity verification for POST /api/session
  package.json         — better-sqlite3, express, cors, express-rate-limit,
                         @sentry/node, appattest-checker-node
  deploy/
    Dockerfile         — two-stage Alpine build (compiles native sqlite, slim runtime)
    fly.toml           — Fly app config (2 machines in ord since the 2026-07-16
                         scale-out — RUNBOOK §14; 512 MB each, /healthz check)
    .dockerignore      — strict allow-list (server files + the lakelore-data
                         runtime files the Dockerfile COPYs — nothing else)
    fetch.sh           — local: scrape one state and POST /reload to dev server
    deploy-data.sh     — production: drift-check, upload .db files to EVERY
                         machine's volume, restart, poll /readyz
    _drift_check.py    — pre-upload safety: aborts if local row counts are BEHIND prod
  .github/workflows/
    uptime.yml         — GitHub Actions uptime probes (every 15 min)
  test/                — smoke tests (test/smoke.js)
```

The deploy artifacts are symlinked from `~/`, so:

- `~/Dockerfile`, `~/fly.toml`, `~/.dockerignore`, `~/fetch.sh`, `~/deploy-data.sh` all resolve into this repo
- `flyctl deploy` from `~/` continues to work (it picks up `~/fly.toml` via the symlink, with build context `~/` so the Dockerfile's `COPY lakelore-data/...` lines still resolve to the sibling canonical-data folder)

The Dockerfile copies this repo's runtime files (`server.js`, `entitlement.js`, `server/canonical.js`, `server/attest.js`) plus the `lakelore-data` runtime files (registry, species map, schema assertion, shared survival model). That cross-folder `COPY` is the reason the build context has to remain `~/`. If `lakelore-data/` ever moves, update the `COPY` lines in `deploy/Dockerfile` and `deploy/.dockerignore`. (The per-state `survival.js` COPY lines and the `STATE_DB_PATHS` block are gone — removed in the P5 cleanup; the shared lakelore-data survival model covers all states.)

## Running locally

```bash
cd ~/lake-fish-mobile-server && npm run dev
```

Server starts on port 3100. There is also a launchd agent (`~/Library/LaunchAgents/com.lakelore.mobile-server.plist`) that auto-starts the server on login; reload it with:

```bash
launchctl unload ~/Library/LaunchAgents/com.lakelore.mobile-server.plist
launchctl load   ~/Library/LaunchAgents/com.lakelore.mobile-server.plist
```

## Deploying

Server code (server.js, Dockerfile, fly.toml):

```bash
cd ~ && ~/.fly/bin/flyctl deploy
```

State databases (drift-check → per-machine upload → restart → `/readyz` gate; `deploy-data.sh` enumerates the Fly machines and uploads to each one's volume via `fly sftp put --machine <id>`, then restarts the app and polls `/readyz` until every active state serves — a bad upload fails there instead of as user-facing 500s):

```bash
~/deploy-data.sh           # all states
~/deploy-data.sh mn        # one state
~/deploy-data.sh mn sd     # several states
```

## Secrets

Fly secrets currently set in production: `RELOAD_TOKEN`, `REVENUECAT_SECRET_KEY`, `REVENUECAT_PROJECT_ID`, `REVENUECAT_WEBHOOK_AUTH`, `SENTRY_DSN`, `LAKELORE_JWT_SECRET` (+ `PLAY_INTEGRITY_SA_JSON` pending Play console steps). Full purpose-by-purpose table: `./CLAUDE.md` "Fly secrets currently set"; storage locations and rotation: `~/APP_OPS.md`.

- `RELOAD_TOKEN` — a copy is stashed at `~/.lakelore_reload_token` (not in repo). Required as `Authorization: Bearer <token>` to call `POST /api/:state/reload` in production. Local dev runs without a token.

To rotate:

```bash
NEW=$(openssl rand -hex 24)
echo "$NEW" > ~/.lakelore_reload_token && chmod 600 ~/.lakelore_reload_token
~/.fly/bin/flyctl secrets set RELOAD_TOKEN="$NEW" --app lake-fish-api
```

## Endpoints

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /healthz` | Liveness | DB-independent. Used by the Fly healthcheck. Bypasses rate limiting. `?deep=1` (2026-07-25) adds per-state detail plus the observability block (**token-gated in production since 2026-07-28**: `Authorization: Bearer <RELOAD_TOKEN>`; failed attempts throttled 30/h/IP): `ver` (client version histogram from X-App-Version), `sig`/`attest` counters, `rc` (cumulative RC-error + webhook counters — the entitlement-outage signal), `memRssMb`, `/data` disk free, jsonl sizes. This is the probe-assertable form of the hourly `[sig]`/`[ver]`/`[rc]`/`[attest]` log lines (RUNBOOK §16 flip evidence). |
| `GET /readyz` | Data-aware readiness | `200` only when EVERY active state serves (DB present, schema valid); `503` with the bad-state list otherwise. `?deep=1` (2026-07-25, was COUNT-only) EXECUTES the REAL `/results` + `/lake` wire projections for one catch-bearing lake per state — the projection throws on unmapped wire fields, so the class that 500s users while a COUNT stays green now fails readiness (cached 60 s). `deploy.sh` and `deploy-data.sh` poll deep on every machine post-deploy/restart. External uptime monitors use the shallow form. Fly's machine check stays on `/healthz` so one bad state can't pull a machine from rotation. |
| `GET /api/:state/status` | Per-state DB readiness + counts | |
| `GET /api/:state/filters` | Available species, gear types (+ `gearTypeCounts`, `gearCpueCounts` — per-gear CPUE-bearing row counts driving the app's default-gear pick — and `gearLatestCounts`, 2026-08-11: distinct-lake counts per gear = what a single-gear query returns under `mostRecentOnly`, shown by the Filters modal when "Latest only" is on), counties, year range | |
| `GET /api/:state/measures` | **Measure × Gear/Source manifest** (DATA_MODEL_PROPOSAL_2026-07-20) | Returns the measures with data in the current `species`/`county` scope, in cascade order (Abundance → Stocking Impact → Avg Size → Presence). Each measure nests its **Gear/Source** options (the required filter under Abundance & Avg Size), each source carrying the exact `{gear, cpueKind, sort, stockingFirst, presenceUnion}` the app sends to `/results`, plus `records`/`lakes` coverage and `defaultSourceId` (most records). Abundance sources: **one per distinct `gear_category`** — gear/creel rows (`expression:catch-per-unit`) and relative rows (`ranking`) each get their own source scoped by `?gear=` (a LIFA 0–5 rating, % composition, and a gill-net index are not one comparable thing, so they are never merged — 2026-07-25); the genuine `normalized` metric stays ONE merged cross-gear source scoped by `?cpueKind=normalized`; plus forecast rating (one per rating system). Presence is the **derived union** of every lake+species (fish_catch ∪ lake_stocking_metrics). Powers the app's Measure selector + Gear/Source filter. Additive/new route — `/filters` and `/results` goldens untouched. |
| `GET /api/:state/results` | Paginated search | Schema v6 (2026-07-17): rows may carry `length_derivation` ('measured' vs 'estimate'/'chart'/'psd_midpoint' — the app renders non-measured as "Est. length") and `presence_basis` ('surveyed' vs 'stocked' for inferred presence), per registry wire lists. Up to 500 rows per request. Paid states without entitlement get **preview mode**: `200` with `preview: true`; lake identity redacted (`lake_name`, `county`, `area_acres`, coords, report/PDF refs all null) and lake/survey ids replaced by deterministic hashes; all metrics intact. **`sortBy=cpue`** ranks rows with a catch rate first, then rows lacking one (net count unstated or mixed-gear catch) below, ordered by raw `total_catch` DESC (length-only rows with neither last). **Measure params (2026-07-20, all optional & parity-safe):** `cpueKind=<gear\|relative\|creel\|normalized>` confines an abundance sort to one class (and scopes the most-recent CTE to that class); `stockingFirst=1` drives results from `lake_stocking_metrics` (Stocking Impact measure — surfaces stocked-but-unsurveyed lakes); `presenceUnion=1` returns the derived-union list (Presence measure). Absent all three, the legacy path is byte-identical. |
| `GET /api/:state/lake/:id` | Lake detail with surveys, catches, stocking, computed metrics | Paid states without entitlement get **preview mode** too (2026-07-15): full detail with the same identity fields + report ids/source links redacted, ids hashed; accepts hashed preview ids from `/results`. Since 2026-07-17 the ratings-tier states (ga/mo/il/fl/ky/ok/ks) carry `rating`/`rating_ordinal` on the catches list (registry `wire.lakeCatches`) so the detail screen can show their headline metric. |
| `POST /api/:state/reload` | Hot-reload the state's DB cache | Requires `RELOAD_TOKEN` in production |
| `GET /api/me/entitlement` | Server-authoritative entitlement check | `X-User-Id` required; returns `{hasAllStates,expiresAt,source}` |
| `GET /api/client-config` | Upgrade nudge / kill switch (2026-07-25, T1.1) | Returns `{minVersion, killedVersions[], message}` from env vars `LAKELORE_MIN_APP_VERSION` / `LAKELORE_KILLED_VERSIONS` (comma list) / `LAKELORE_UPGRADE_MESSAGE` — all unset by default (no-op). 1.1.1+ clients check on launch/foreground: killed → blocking update screen; below minVersion → dismissible prompt. Flip via `flyctl secrets set` (RUNBOOK §17). Cache-Control 5 min. |
| `GET /api/session/challenge` | Attestation challenge for session issuance | Requires `X-User-Id` + valid `X-User-Sig`. Stateless HMAC nonce bound to the userId, 10-min TTL — verifies on either Fly machine. |
| `POST /api/session` | Mint a 7-day HS256 session token | Requires `X-User-Id` + valid `X-User-Sig`. Optional JSON body `{platform, challenge, keyId?, attestation?, token?}` carries an App Attest (iOS) / Play Integrity (Android) proof — verified server-side (`server/attest.js`), stamps `att: ios\|android\|none` on the token and `attested` on the response. Unattested issuance still succeeds until `LAKELORE_REQUIRE_ATTEST=1` (RUNBOOK §16). Telemetry: hourly `[attest]` log + `attest` in `/healthz?deep=1`. |
| `POST /api/feedback` | Capture in-app feedback | Appends one JSON line per submission to `/data/feedback.jsonl` on the volume. `message` 1–2000 chars, all other fields optional. Bodies capped at 16 KB (global `express.json` limit); the jsonl file is capped at 50 MB (503 `storage_full` beyond — truncate after export to recover). |
| `POST /api/subscribe` | Marketing-site email capture | Appends `{ts, email, state, source}` to `/data/subscribers.jsonl` on the volume **of whichever machine served the request** — with two machines the full list only exists as the union. Export/backup via `~/lakelore-data/bin/backup-userdata.sh` (pulls BOTH machines, merges+dedupes, syncs to B2 `userdata/`; runs inside the weekly backup sweep). Do NOT use a single-machine `fly ssh console -C cat` — it silently undercounts. Email format-validated (≤320 chars), other fields truncated. **Public unauthenticated write surface** — only the global rate limit stands between it and the disk. |
| `GET /api/:state/lakes-index` | Public SEO index for the marketing site | Lake names + per-lake survey/species/stocking **counts** only, no metrics — powers lakeloreapp.com's programmatic per-lake pages. Deliberately NOT in the entitlement gate (the lake name is the search term; the numbers stay behind the sub). 6-hour in-memory cache per state. |
| `POST /webhooks/revenuecat` | RevenueCat purchase-event webhook | Invalidates the per-user entitlement cache so `/api/me/entitlement` sees changes before the 5-min TTL. Auth: `Authorization` header compared byte-for-byte to `REVENUECAT_WEBHOOK_AUTH`; if the secret is unset, accepts unsigned events with a warning log. |

## Hardening summary (2026-05-05)

- `app.set('trust proxy', 1)` — real client IP behind Fly's proxy
- Rate limit: 600 req / 15 min per IP, applied to `/api/*` only
- CORS allow-list: `lakeloreapp.com`, `www.lakeloreapp.com`, plus LAN dev origins; mobile native fetch (no Origin header) is unaffected
- `/api/:state/reload` requires bearer token in production
- Healthcheck on `/healthz` instead of `/api/mn/status`
