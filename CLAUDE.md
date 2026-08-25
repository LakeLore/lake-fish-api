# lake-fish-api — Working Context

*Last reconciled with code: 2026-07-17.*

Express + better-sqlite3 API behind LakeLore. Hosted on Fly.io (`lake-fish-api`, Chicago, `ord`). Reads read-only canonical state SQLite databases (built by `~/lakelore-data`) from a persistent volume at `/data/`.

> **Endpoint reference and routine ops:** `./README.md`.
> **Vendor accounts, secrets, identifiers, gotchas:** `~/APP_OPS.md`.
> **Emergency runbook (rollback, secret rotation, etc.):** `~/RUNBOOK.md`.
> **Data pipelines (how DBs get populated per state):** `~/DATA_PIPELINES.md`.

---

## File map

```
server.js                 — Express app + all routes (single file, ~800 lines;
                            was 1473 with legacy branches pre-P5-cleanup);
                            unconditional dispatch to the canonical handlers
                            for every active state
server/canonical.js       — generic registry-driven filters/results/lake handlers
                            (wire projection per registry wire lists; query plans
                            pinned for tie-order parity — see PARITY_NOTES)
server/attest.js          — App Attest (iOS) / Play Integrity (Android) proof
                            verification for POST /api/session; challenge HMAC
                            derived from LAKELORE_JWT_SECRET
entitlement.js            — RC v2 entitlement gate + cache
package.json              — express, cors, better-sqlite3, express-rate-limit,
                            @sentry/node
deploy/
  deploy.sh               — test-gated image deploy (2026-07-17, B5): smoke +
                            parity spot-replay, then flyctl deploy. Use this,
                            not bare flyctl deploy.
  Dockerfile              — two-stage Alpine build; copies server.js + entitlement.js
                            + server/canonical.js + the lakelore-data runtime files
                            (registry, species map, schema assertion, shared survival).
                            Build context is ~/ (so cross-folder COPY works).
  fly.toml                — two machines in ord (2026-07-16 scale-out, RUNBOOK
                            §14), 512 MB each, /healthz check
  .dockerignore           — strict allow-list
  fetch.sh                — local: scrape one state and POST /reload to dev server
  deploy-data.sh          — production: drift-check, sftp state DBs to EVERY
                            machine's volume (`fly sftp put --machine <id>`),
                            restart, poll /readyz
  _drift_check.py         — pre-upload safety: diffs local vs prod row counts
                            for lakes/surveys/fish_catch/stocking, aborts the
                            deploy if local is BEHIND prod (suggesting a
                            stale snapshot). Invoked by deploy-data.sh, or run
                            standalone via `./deploy-data.sh --check`.
.github/workflows/
  uptime.yml              — GitHub Actions uptime probes against prod (every
                            15 min)
```

All five deploy artifacts are symlinked from `~/` so existing commands (`flyctl deploy`, `~/fetch.sh`, `~/deploy-data.sh`) still work after the move into `deploy/`.

## Architecture in 30 seconds

- Two Fly machines in ord (since the 2026-07-16 scale-out, RUNBOOK §14 — forked volume, so each machine has its own `/data` copy; one auto-stops when idle), each running one Express process with one read-only SQLite connection per active state (lazily opened; canonical artifacts are immutable snapshots, no WAL). `deploy-data.sh` uploads to every machine, so the volumes never split.
- **Registry-driven ACTIVE_STATES (2026-07-15 all-states launch):** `server.js` derives `ACTIVE_STATES` from `lakelore-data/registry/states.json` `active:true` flags — no more hand-mirrored literal. All 56 states/provinces (50 US + ON/BC/QC/MB/SK/AB) are active. DB paths resolve `{STATE}_DB_PATH` env → `LAKELORE_DB_DIR/{state}.db` (production sets `LAKELORE_DB_DIR=/data`) → local `../lakelore-data/out/{state}.db`.
- **Canonical-only serving (P5 cleanup, 2026-07):** every active state is served by the generic registry-driven handlers (`server/canonical.js`) against a canonical-schema DB built by `lakelore-data`'s `normalize.js`. The legacy per-state branches, species maps, SD startup migration (`migrateSd`/`computeSdStockingMetrics`), in-memory stocking metrics, and per-state `../{state}-lake-fish/survival.js` requires were all DELETED from `server.js` (1473 → ~550 lines) after each state was parity-proven (`~/lakelore-data/bin/parity.js`; whitelists + P5 byte-identical replay verification in `~/lakelore-data/reports/PARITY_NOTES.md`). Routes are: validateState → canonical handler, unconditionally. **`../lakelore-data` is a hard startup requirement** — if it's missing the process exits 1 immediately. An active state the registry doesn't mark `canonical: true` is a config error: loud startup log + 503 on its routes (not a crash). The `CANONICAL_STATES` env override no longer exists; rollback = Fly image rollback (`~/RUNBOOK.md` §2/§9b). Startup validates each state's schema (mismatch → that state 503s `state unhealthy`, others unaffected) and `GET /healthz?deep=1` reports per-state `{ok, lakes, generatedAt, ageDays, schemaOk}`.
- Stocking metrics: `/results` reads the precomputed `lake_stocking_metrics` table baked into each artifact; `/lake/:id` computes "adults per 100 acres" on the fly via the shared `~/lakelore-data/survival` model (equivalence-proven against the retired per-state modules) + registry species resolution.
- Entitlement gate via `entitlement.js` middleware: paid-state `/pdf` returns 402 without entitlement (the document names the lake). Paid-state `/results` AND `/lake/:id` (since 2026-07-15) pass through in **preview mode** for non-subscribers (`req.lakeLorePreview = true`): the canonical handlers return every metric but redact lake IDENTITY — `lake_name`/`name`, `county`, `area_acres`, `latitude`/`longitude`, `location`, `shore_length_miles`, plus `report_id`/`source_pdf`/`source_url` on surveys+catches and `latest_stocking_report_id` — and replace lake/survey ids with deterministic keyed hashes (`previewId` in `server/canonical.js`; several 2026-07 states derive raw ids from the lake name). `/lake/:id` resolves hashed ids back via a lazily-built per-state reverse map. Responses carry `preview: true`. `/status` and `/filters` stay public. MN is the free state; the gated-path regex is generated from registry `active` flags.
- 5-min per-user entitlement cache (in-memory; error results 30 s via per-entry `_ttl`). Invalidated by RC webhook events at `POST /webhooks/revenuecat`. `FREE_STATES` derives from registry `free:true` flags (2026-07-17). **RC-outage grace (72 h)**: last-positive entitlements per user persist write-through to `/data/entitlement-lastgood.json` per machine (2026-07-17), so a restart/failover mid-outage no longer wipes the grace map; `/api/me/entitlement` returns `source`, and the 1.1.0 client treats `rc-error` as "fall back to the on-device RC SDK receipt" instead of an authoritative false.
- **Important — RC v2 active_entitlements gotcha:** the `/v2/projects/{id}/customers/{user_id}/active_entitlements` endpoint returns items that carry only `entitlement_id` (`entl_xxx`), never `lookup_key`. We resolve `LakeLore All-States` → its `entl_xxx` ID once at process startup (`_resolveAllStatesEntitlementId`) and match on the internal ID. If the entitlement is ever recreated in the RC dashboard, restart the server to pick up the new ID.
- Rate limit 600 req / 15 min per IP via `express-rate-limit`. `app.set('trust proxy', 1)` for real client IP behind Fly's edge.

## Deploy

```bash
# Preferred (2026-07-17, test-gated): smoke tests + parity spot-replay
# (mn/tx/ga) run first and BLOCK the deploy on failure.
~/lake-fish-mobile-server/deploy/deploy.sh

# Raw escape hatch (skips the gates — emergencies only):
cd ~ && ~/.fly/bin/flyctl deploy --config ~/lake-fish-mobile-server/deploy/fly.toml
```

A deliberate wire change fails the parity gate by design — re-record the
goldens (`node ~/lakelore-data/bin/parity.js <st> --record golden/<st>/`)
first; that forced review step is the point.

The Dockerfile's COPY directives reference both this folder (`lake-fish-mobile-server/server.js`) and the sibling `lakelore-data/` package (registry, species map, schema files, shared survival model), which is why the build context is `~/` rather than this folder. The per-state `{state}-lake-fish/survival.js` COPY lines were removed in the P5 cleanup — the shared model covers all states. If `lakelore-data/` ever moves, update `deploy/Dockerfile` and `deploy/.dockerignore` accordingly.

## Fly secrets currently set

| Secret | Purpose |
|---|---|
| `RELOAD_TOKEN` | Bearer auth for `POST /api/:state/reload` in prod |
| `REVENUECAT_SECRET_KEY` | v2 secret key (scoped Customers/Subscriptions/Entitlements: Read) |
| `REVENUECAT_PROJECT_ID` | RC project short ID (`5155d3e4`) |
| `REVENUECAT_WEBHOOK_AUTH` | Compared byte-for-byte to the `Authorization` header on `POST /webhooks/revenuecat`. When unset the handler accepts unsigned events (warning log only). Local copy at `~/.lakelore_rc_webhook_auth`. |
| `SENTRY_DSN` | Server-side Sentry error reporting |
| `LAKELORE_JWT_SECRET` | Signs 7-day HS256 session tokens (POST /api/session) AND keys the attestation challenge HMAC (server/attest.js derives from it) AND derives the preview-id hashing key (server/canonical.js, 2026-07-17 — an explicit `PREVIEW_ID_SECRET` env would override; none is set). **Required at boot in production since 2026-07-17**: server.js exits 1 if NODE_ENV=production and it's unset, because the repo-default fallbacks would make session tokens forgeable and preview ids offline-reversible with nothing failing. |
| `PLAY_INTEGRITY_SA_JSON` | **SET 2026-08-24 (O6)** — full Google service-account JSON used to decode Play Integrity tokens; Play console linking done same day (see ~/APP_OPS.md "App Attest / Play Integrity"). Android attestation live for build 21+; enforcement flip still OFF per RUNBOOK §16. |

Audit current: `~/.fly/bin/flyctl secrets list --app lake-fish-api`.

## Source-of-truth note on data

This server reads `*.db` files; it does not write them. Fresh state data comes from running `~/fetch.sh <state>` (which chains `fetcher.js` and any sibling steps — MN and ND also require `stock-fetcher.js` to build `stocking` / `lake_stocking_metrics`; skipping it ships a DB that 500s on `/results`) → `~/deploy-data.sh` to upload to the Fly volume → either `fly app restart` or `POST /reload` with the bearer token to reload caches without restart. **Always consult `~/DATA_PIPELINES.md` for the state-specific pipeline before refreshing** — pipelines differ per state. For canonical states, prefer `~/lakelore-data/bin/refresh.sh <state> [--deploy]` — it chains fetch → normalize (validation gates BLOCK bad data) → B2 backup → deploy. `deploy-data.sh` and `_drift_check.py` are registry-aware: canonical states ship `~/lakelore-data/out/<state>.db`, legacy states ship the raw scraper DB.

## Reading order for a fresh Claude session

1. This file (auto-loaded when CWD is `~/lake-fish-mobile-server/`).
2. `./README.md` — endpoint table, secrets, deploy commands, hardening summary.
3. `~/APP_OPS.md` — broader vendor and identifier reference.
4. `~/RUNBOOK.md` if something is broken.
5. `~/DATA_PIPELINES.md` if working on state data ingestion.

## Self-check before ending a server task

Full trigger table in `~/CLAUDE.md` "Documentation discipline". Server-specific:

- [ ] If I added/removed/renamed an endpoint — `./README.md` endpoint table updated.
- [ ] If I changed the entitlement gate (which states are gated, response shape) — `entitlement.js`, this file's architecture section, and `~/lake-fish-mobile/CLAUDE.md` paywall section all describe the same thing.
- [ ] If I added a Fly secret — `~/APP_OPS.md` Fly secrets table + this file's secrets table + (if rotation procedure new) `~/RUNBOOK.md`.
- [ ] If I changed the Dockerfile or fly.toml — verified `~/.fly/bin/flyctl deploy` from `~/` still works.
- [ ] If I changed how state DBs are read/located — `~/DATA_PIPELINES.md` and `~/APP_OPS.md` are still right.
- [ ] If a deploy failed and I learned a new failure mode — `~/RUNBOOK.md` has the recipe.
- [ ] If I bumped a dependency that affects runtime — verified production still healthy (`curl /healthz` and a sample state-data call).
