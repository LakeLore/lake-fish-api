# lake-fish-api

*Last reconciled with code: 2026-07-17.*

The unified Express + SQLite API server behind the **LakeLore** mobile app and marketing site, deployed to Fly.io as `lake-fish-api` (https://lake-fish-api.fly.dev).

Serves the active states at `/api/{state}/{status|filters|results|lake/:id}` plus a `/healthz` and a token-protected `/api/:state/reload`. **The active set is 50 registry states — 45 US states + 5 Canadian provinces (ON, BC, MB, SK, AB) — as of the 2026-07-15 all-states launch. The 6 states with no stocking AND no CPUE data (SC, AZ, MA, DE, RI, QC) stay `active:false` until they earn a metric; CA (measured lengths), GA (length estimates), and MO (ratings) are kept active despite lacking CPUE/stocking metrics.** `ACTIVE_STATES` is derived at startup from `active: true` flags in `~/lakelore-data/registry/states.json` (the authoritative registry; no hand-mirrored literal anymore). Every active state is canonical and serves from `LAKELORE_DB_DIR/{state}.db` (`/data` in production; a per-state `{STATE}_DB_PATH` env still overrides). The registry `country` field (`"CA"`) distinguishes Canadian provinces. `LAKELORE_ACTIVE_STATES_EXTRA` remains as a dev affordance for smoke-testing a state not yet flagged active (never set in production).

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
| `GET /healthz` | Liveness | DB-independent. Used by the Fly healthcheck. Bypasses rate limiting. |
| `GET /readyz` | Data-aware readiness | `200` only when EVERY active state serves (DB present, schema valid); `503` with the bad-state list otherwise. `?deep=1` (2026-07-17) additionally EXECUTES a query per state (catches post-startup corruption; cached 60 s) — `deploy-data.sh` polls deep on every machine directly after restart. External uptime monitors use the shallow form. Fly's machine check stays on `/healthz` so one bad state can't pull a machine from rotation. |
| `GET /api/:state/status` | Per-state DB readiness + counts | |
| `GET /api/:state/filters` | Available species, gear types (+ `gearTypeCounts` and `gearCpueCounts` — per-gear CPUE-bearing row counts the app uses for its default-gear pick), counties, year range | |
| `GET /api/:state/results` | Paginated search | Up to 500 rows per request. Paid states without entitlement get **preview mode**: `200` with `preview: true`; lake identity redacted (`lake_name`, `county`, `area_acres`, coords, report/PDF refs all null) and lake/survey ids replaced by deterministic hashes; all metrics intact. **`sortBy=cpue`** ranks rows with a catch rate first, then rows lacking one (net count unstated or mixed-gear catch) below, ordered by raw `total_catch` DESC (length-only rows with neither last). |
| `GET /api/:state/lake/:id` | Lake detail with surveys, catches, stocking, computed metrics | Paid states without entitlement get **preview mode** too (2026-07-15): full detail with the same identity fields + report ids/source links redacted, ids hashed; accepts hashed preview ids from `/results`. Since 2026-07-17 the ratings-tier states (ga/mo/il/fl/ky/ok/ks) carry `rating`/`rating_ordinal` on the catches list (registry `wire.lakeCatches`) so the detail screen can show their headline metric. |
| `POST /api/:state/reload` | Hot-reload the state's DB cache | Requires `RELOAD_TOKEN` in production |
| `GET /api/ne/pdf/:name` | Stream Nebraska survey PDFs | Path-traversal protected |
| `GET /api/me/entitlement` | Server-authoritative entitlement check | `X-User-Id` required; returns `{hasAllStates,expiresAt,source}` |
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
