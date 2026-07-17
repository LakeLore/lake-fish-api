# lake-fish-api

The unified Express + SQLite API server behind the **LakeLore** mobile app and marketing site, deployed to Fly.io as `lake-fish-api` (https://lake-fish-api.fly.dev).

Serves the active states at `/api/{state}/{status|filters|results|lake/:id}` plus a `/healthz` and a token-protected `/api/:state/reload`. **The active set is 50 registry states — 45 US states + 5 Canadian provinces (ON, BC, MB, SK, AB) — as of the 2026-07-15 all-states launch. The 6 states with no stocking AND no CPUE data (SC, AZ, MA, DE, RI, QC) stay `active:false` until they earn a metric; CA (measured lengths), GA (length estimates), and MO (ratings) are kept active despite lacking CPUE/stocking metrics.** `ACTIVE_STATES` is derived at startup from `active: true` flags in `~/lakelore-data/registry/states.json` (the authoritative registry; no hand-mirrored literal anymore). Every active state is canonical and serves from `LAKELORE_DB_DIR/{state}.db` (`/data` in production; a per-state `{STATE}_DB_PATH` env still overrides). The registry `country` field (`"CA"`) distinguishes Canadian provinces. `LAKELORE_ACTIVE_STATES_EXTRA` remains as a dev affordance for smoke-testing a state not yet flagged active (never set in production).

## Layout

```
lake-fish-mobile-server/
  server.js            — the API (one file, ~900 lines)
  package.json         — better-sqlite3, express, cors, express-rate-limit
  deploy/
    Dockerfile         — two-stage Alpine build (compiles native sqlite, slim runtime)
    fly.toml           — Fly app config (1 machine in ord, 512 MB, /healthz check)
    .dockerignore      — strict allow-list (server.js + survival.js modules only)
    fetch.sh           — local: scrape one state and POST /reload to dev server
    deploy-data.sh     — production: sftp .db files to the Fly volume + restart
```

The deploy artifacts are symlinked from `~/`, so:

- `~/Dockerfile`, `~/fly.toml`, `~/.dockerignore`, `~/fetch.sh`, `~/deploy-data.sh` all resolve into this repo
- `flyctl deploy` from `~/` continues to work (it picks up `~/fly.toml` via the symlink, with build context `~/` so the Dockerfile's `COPY mn-lake-fish/survival.js ...` lines still resolve to sibling state folders)

That cross-folder `COPY` is the reason the Dockerfile's build context has to remain `~/`. If the state folders ever move, update the `COPY` lines in `deploy/Dockerfile` and the `STATE_DB_PATHS` block in `server.js`.

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

State databases (sftp upload to the Fly volume + restart):

```bash
~/deploy-data.sh           # all states
~/deploy-data.sh mn        # one state
~/deploy-data.sh mn sd     # several states
```

## Secrets

- `RELOAD_TOKEN` — set as a Fly secret. A copy is stashed at `~/.lakelore_reload_token` (not in repo). Required as `Authorization: Bearer <token>` to call `POST /api/:state/reload` in production. Local dev runs without a token.

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
| `GET /api/:state/status` | Per-state DB readiness + counts | |
| `GET /api/:state/filters` | Available species, gear types (+ `gearTypeCounts` and `gearCpueCounts` — per-gear CPUE-bearing row counts the app uses for its default-gear pick), counties, year range | |
| `GET /api/:state/results` | Paginated search | Up to 500 rows per request. Paid states without entitlement get **preview mode**: `200` with `preview: true`; lake identity redacted (`lake_name`, `county`, `area_acres`, coords, report/PDF refs all null) and lake/survey ids replaced by deterministic hashes; all metrics intact. **`sortBy=cpue`** ranks rows with a catch rate first, then rows lacking one (net count unstated or mixed-gear catch) below, ordered by raw `total_catch` DESC (length-only rows with neither last). |
| `GET /api/:state/lake/:id` | Lake detail with surveys, catches, stocking, computed metrics | Paid states without entitlement get **preview mode** too (2026-07-15): full detail with the same identity fields + report ids/source links redacted, ids hashed; accepts hashed preview ids from `/results`. |
| `POST /api/:state/reload` | Hot-reload the state's DB cache | Requires `RELOAD_TOKEN` in production |
| `GET /api/ne/pdf/:name` | Stream Nebraska survey PDFs | Path-traversal protected |
| `GET /api/me/entitlement` | Server-authoritative entitlement check | `X-User-Id` required; returns `{hasAllStates,expiresAt,source}` |
| `GET /api/session/challenge` | Attestation challenge for session issuance | Requires `X-User-Id` + valid `X-User-Sig`. Stateless HMAC nonce bound to the userId, 10-min TTL — verifies on either Fly machine. |
| `POST /api/session` | Mint a 7-day HS256 session token | Requires `X-User-Id` + valid `X-User-Sig`. Optional JSON body `{platform, challenge, keyId?, attestation?, token?}` carries an App Attest (iOS) / Play Integrity (Android) proof — verified server-side (`server/attest.js`), stamps `att: ios\|android\|none` on the token and `attested` on the response. Unattested issuance still succeeds until `LAKELORE_REQUIRE_ATTEST=1` (RUNBOOK §16). Telemetry: hourly `[attest]` log + `attest` in `/healthz?deep=1`. |
| `POST /api/feedback` | Capture in-app feedback | Appends one JSON line per submission to `/data/feedback.jsonl` on the volume. `message` 1–2000 chars, all other fields optional. |

## Hardening summary (2026-05-05)

- `app.set('trust proxy', 1)` — real client IP behind Fly's proxy
- Rate limit: 600 req / 15 min per IP, applied to `/api/*` only
- CORS allow-list: `lakeloreapp.com`, `www.lakeloreapp.com`, plus LAN dev origins; mobile native fetch (no Origin header) is unaffected
- `/api/:state/reload` requires bearer token in production
- Healthcheck on `/healthz` instead of `/api/mn/status`
