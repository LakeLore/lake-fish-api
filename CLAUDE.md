# lake-fish-api — Working Context

Express + better-sqlite3 API behind LakeLore. Hosted on Fly.io (`lake-fish-api`, Chicago, `ord`). Reads 7 read-only state SQLite databases from a persistent volume at `/data/`.

> **Endpoint reference and routine ops:** `./README.md`.
> **Vendor accounts, secrets, identifiers, gotchas:** `~/APP_OPS.md`.
> **Emergency runbook (rollback, secret rotation, etc.):** `~/RUNBOOK.md`.
> **Data pipelines (how DBs get populated per state):** `~/DATA_PIPELINES.md`.

---

## File map

```
server.js                 — Express app + all routes (~1100 lines)
entitlement.js            — RC v2 entitlement gate + cache
package.json              — express, cors, better-sqlite3, express-rate-limit,
                            @sentry/node
deploy/
  Dockerfile              — two-stage Alpine build; copies server.js + entitlement.js
                            + survival.js modules from sibling state folders.
                            Build context is ~/ (so cross-folder COPY works).
  fly.toml                — single machine in ord, 512 MB, /healthz check
  .dockerignore           — strict allow-list
  fetch.sh                — local: scrape one state and POST /reload to dev server
  deploy-data.sh          — production: sftp state DBs to Fly volume + restart
```

All five deploy artifacts are symlinked from `~/` so existing commands (`flyctl deploy`, `~/fetch.sh`, `~/deploy-data.sh`) still work after the move into `deploy/`.

## Architecture in 30 seconds

- One Fly machine, one Express process, 7 SQLite connections (one per state, read-only WAL, lazily opened).
- Survival modules required per state via `../{state}-lake-fish/survival.js` at runtime — these compute "adults per 100 acres" from stocking records on the fly per lake.
- Entitlement gate via `entitlement.js` middleware: paid-state `/results`, `/lake/:id`, `/pdf` return 402 without entitlement. `/status` and `/filters` stay public. MN is the free state.
- 5-min per-user entitlement cache (in-memory). Invalidated by RC webhook events at `POST /webhooks/revenuecat`.
- Rate limit 600 req / 15 min per IP via `express-rate-limit`. `app.set('trust proxy', 1)` for real client IP behind Fly's edge.

## Deploy

```bash
# From ~/ (Docker build context):
cd ~ && ~/.fly/bin/flyctl deploy
```

The Dockerfile's COPY directives reference both this folder (`lake-fish-mobile-server/server.js`) and sibling state folders (`mn-lake-fish/survival.js` etc.), which is why the build context is `~/` rather than this folder. If state folders ever move, update `deploy/Dockerfile` accordingly.

## Fly secrets currently set

| Secret | Purpose |
|---|---|
| `RELOAD_TOKEN` | Bearer auth for `POST /api/:state/reload` in prod |
| `REVENUECAT_SECRET_KEY` | v2 secret key (scoped Customers/Subscriptions/Entitlements: Read) |
| `REVENUECAT_PROJECT_ID` | RC project short ID (`5155d3e4`) |
| `SENTRY_DSN` | Server-side Sentry error reporting |

Audit current: `~/.fly/bin/flyctl secrets list --app lake-fish-api`.

## Source-of-truth note on data

This server reads `*.db` files; it does not write them. Fresh state data comes from the per-state scrapers (`~/{state}-lake-fish/fetcher.js`) → `~/deploy-data.sh` to upload to the Fly volume → either `fly app restart` or `POST /reload` with the bearer token to reload caches without restart. See `~/DATA_PIPELINES.md` for the full story.

## Reading order for a fresh Claude session

1. This file (auto-loaded when CWD is `~/lake-fish-mobile-server/`).
2. `./README.md` — endpoint table, secrets, deploy commands, hardening summary.
3. `~/APP_OPS.md` — broader vendor and identifier reference.
4. `~/RUNBOOK.md` if something is broken.
5. `~/DATA_PIPELINES.md` if working on state data ingestion.
