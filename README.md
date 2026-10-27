# lake-fish-api

*Last reconciled with code: 2026-09-18 (v8 production deploy).*

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
    ask.js             — Ask LakeLore agent (POST /api/:state/ask; off unless LAKELORE_ASK_ENABLED=1)
  bin/
    ask.js             — terminal chat harness for the ask route (not shipped in the image)
  package.json         — better-sqlite3, express, cors, express-rate-limit,
                         @sentry/node, appattest-checker-node
  deploy/
    Dockerfile         — two-stage Alpine build (compiles native sqlite, slim runtime)
    fly.toml           — Fly app config (2 machines in ord since the 2026-07-16
                         scale-out — RUNBOOK §14; 512 MB each, /healthz check)
    fly.staging.toml   — STAGING app `lake-fish-api-staging` (2026-09-11): same image,
                         own volume, idles to zero, LAKELORE_ASK_ENABLED=1 — RUNBOOK §19
    .dockerignore      — strict allow-list (server files + the lakelore-data
                         runtime files the Dockerfile COPYs — nothing else)
    fetch.sh           — local: scrape one state and POST /reload to dev server
    deploy-data.sh     — production: drift-check, upload .db files to EVERY
                         machine's volume, restart, poll /readyz
    _drift_check.py    — pre-upload safety: aborts if local row counts are BEHIND prod
  .github/workflows/
    uptime.yml         — GitHub Actions uptime probes (scheduled every 15 min; GitHub
                         actually runs it roughly every 4 h — see RUNBOOK §1)
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

**Staging** (2026-09-11 — `lake-fish-api-staging`, RUNBOOK §19): the same two scripts, retargeted by one variable each; production defaults are unchanged when the variable is unset.

```bash
FLY_CONFIG=deploy/fly.staging.toml ~/lake-fish-mobile-server/deploy/deploy.sh   # image (same gates)
LAKELORE_FLY_APP=lake-fish-api-staging ~/deploy-data.sh mn                     # data (drift check vs staging)
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
| `GET /api/:state/filters` | Available species, gear types (+ `gearTypeCounts`, `gearCpueCounts` — per-gear CPUE-bearing row counts driving the app's default-gear pick — and `gearLatestCounts`, 2026-08-11: distinct-lake counts per gear = what a single-gear query returns under `mostRecentOnly`, shown by the Filters modal when "Latest only" is on), counties, year range | Responses cached in-memory per (path+query), LRU 150 / 6 h TTL, dropped per state on `/reload` (2026-08-25 — the unfiltered MN call cost ~1 s of synchronous CPU per new-user session). |
| `GET /api/:state/measures` | **Measure × Gear/Source manifest** (DATA_MODEL_PROPOSAL_2026-07-20) | Returns the measures with data in the current `species`/`county` scope, in cascade order (Abundance → Stocking Impact → Avg Size → Presence). Each measure nests its **Gear/Source** options (the required filter under Abundance & Avg Size), each source carrying the exact `{gear, cpueKind, sort, stockingFirst, presenceUnion}` the app sends to `/results`, plus `records`/`lakes` coverage and `defaultSourceId` (**most records among quantitative sources** — `sort:'cpue'` measured/relative/normalized rates outrank ranking sources; ratings lead only where no quantitative source exists. Changed 2026-08-14 from plain most-records, which let WI's 1,147-lake coarse Forecast Rating hide its 330-row measured corpus; mirrors the legacy client defaultGearFor rule. Only wi/il/ga manifests flipped). Abundance sources: **one per distinct `gear_category`** — gear/creel rows (`expression:catch-per-unit`) and relative rows (`ranking`) each get their own source scoped by `?gear=` (a LIFA 0–5 rating, % composition, and a gill-net index are not one comparable thing, so they are never merged — 2026-07-25); the genuine `normalized` metric stays ONE merged cross-gear source scoped by `?cpueKind=normalized`; plus forecast rating (one per rating system). Presence is the **derived union** of every lake+species (fish_catch ∪ lake_stocking_metrics). Powers the app's Measure selector + Gear/Source filter. **`/results` `gear`** is a comma-joined list and gear names may contain commas — `splitGearParam` rejoins pieces that form a real gear (2026-10-27; comma-named gears previously returned nothing). **Tiny gears hidden (2026-10-27):** a gear source whose rows that can rank in that measure cover fewer than `LAKELORE_MIN_SOURCE_LAKES` (default 3) lakes **statewide** is left out of `sources`; `/filters` drops the same tiny gears from `gearTypes` and its count maps. Neither hides the default source/gear or empties a list; **defaults (`defaultSourceId`, `/filters` `defaultGear` — now always sent) follow the recent-coverage rule** (most lakes surveyed in the artifact's latest 10 survey years, deterministic tie-break; standard boat electrofishing first for bass/bluegill at ≥40% of the leader; creel and size-limited rates never; IA unchanged; most-rows fallback — `recentDefaultGear`, GEAR_CONSOLIDATION.md); county scope never hides a statewide-large gear; the lake page still shows the data. A source's `unit` is the trailing parenthetical of its gear only when that reads as a rate (`#/mile`, `fish/hour`, `per net-night`…), and `label` is the gear without it — mesh/length qualifiers like `(3/8 inch)` stay in the label. Convention and per-state merges: `~/lakelore-data/GEAR_CONSOLIDATION.md`. **Trophy Abundance (2026-09-10, schema v8; SINGLE TIER since 2026-09-11 — owner call "only true trophies"):** measure id `trophy` (after Avg Size, never a default) for states with `cpue_memorable` data on the wire (nd/va + held ks; SD has none — its only clean derivation was preferred-plus, below the trophy bar) — one source per gear (`trophy:<gear>`, sort `cpue_memorable` = catch rate of fish ≥ the Gabelhouse MEMORABLE length, e.g. 25" walleye; defaultSourceId prefers non-ranking). `cpue_preferred` stays on the wire, unsurfaced. Additive/new route — `/filters` and `/results` goldens untouched. Cached like `/filters` (2026-08-25). |
| `GET /api/:state/results` | Paginated search | Schema v6 (2026-07-17): rows may carry `length_derivation` ('measured' vs 'estimate'/'chart'/'psd_midpoint' — the app renders non-measured as "Est. length") and `presence_basis` ('surveyed' vs 'stocked' for inferred presence), per registry wire lists. Up to 500 rows per request. Paid states without entitlement get **preview mode**: `200` with `preview: true`; lake identity redacted (`lake_name`, `county`, `area_acres`, coords, report/PDF refs all null) and lake/survey ids replaced by deterministic hashes; all metrics intact. **`sortBy=cpue`** ranks rows with a catch rate first, then rows lacking one (net count unstated or mixed-gear catch) below, ordered by raw `total_catch` DESC (length-only rows with neither last). **Measure params (2026-07-20, all optional & parity-safe):** `cpueKind=<gear\|relative\|creel\|normalized>` confines an abundance sort to one class (and scopes the most-recent CTE to that class); `stockingFirst=1` drives results from `lake_stocking_metrics` (Stocking Impact measure — surfaces stocked-but-unsurveyed lakes); `presenceUnion=1` returns the derived-union list (Presence measure). Absent all three, the legacy path is byte-identical. |
| `GET /api/:state/lake/:id` | Lake detail with surveys, catches, stocking, computed metrics | Paid states without entitlement get **preview mode** too (2026-07-15): full detail with the same identity fields + report ids/source links redacted, ids hashed; accepts ONLY hashed preview ids from `/results` — a RAW id in preview mode returns `402 subscription_required` (2026-08-25: the public `/lakes-index` carries real ids for SEO pages, so raw-id preview responses let an unauthenticated caller join identity to the full redacted metrics and scrape the paid dataset; app preview flows only ever hold hashed ids). Since 2026-07-17 the ratings-tier states (ga/mo/il/fl/ky/ok/ks) carry `rating`/`rating_ordinal` on the catches list (registry `wire.lakeCatches`) so the detail screen can show their headline metric. |
| `POST /api/:state/reload` | Hot-reload the state's DB cache | Requires `RELOAD_TOKEN` in production |
| `GET /api/me/entitlement` | Server-authoritative entitlement check | `X-User-Id` required; returns `{hasAllStates,expiresAt,source}` `X-Entitlement-Refresh: 1` (sent by 1.1.2+ clients for 10 min after a local purchase/restore, on every request) lets the server re-check a cached NEGATIVE older than 5 s instead of serving it for the rest of the 5-min TTL; a cached positive is never re-checked by it. |
| `GET /api/client-config` | Upgrade nudge / kill switch (2026-07-25, T1.1) | Returns `{minVersion, killedVersions[], message}` from env vars `LAKELORE_MIN_APP_VERSION` / `LAKELORE_KILLED_VERSIONS` (comma list) / `LAKELORE_UPGRADE_MESSAGE` — all unset by default (no-op). 1.1.1+ clients check on launch/foreground: killed → blocking update screen; below minVersion → dismissible prompt. Flip via `flyctl secrets set` (RUNBOOK §17). Cache-Control 5 min. Since 2026-10-08 also returns `states.active` (the served state list; 1.1.2+ clients intersect it with their baked list so a pulled state disappears from the picker instead of 400ing). Since 2026-10-20 also returns `ask.enabled` (`LAKELORE_ASK_ENABLED` and the route open); 1.1.2+ clients hide the Ask LakeLore entry points when it is false — RUNBOOK §20. |
| `GET /api/session/challenge` | Attestation challenge for session issuance | Requires `X-User-Id` + valid `X-User-Sig`. Stateless HMAC nonce bound to the userId, 10-min TTL — verifies on either Fly machine. |
| `POST /api/session` | Mint a 7-day HS256 session token | Requires `X-User-Id` + valid `X-User-Sig`. Optional JSON body `{platform, challenge, keyId?, attestation?, token?}` carries an App Attest (iOS) / Play Integrity (Android) proof — verified server-side (`server/attest.js`), stamps `att: ios\|android\|none` on the token and `attested` on the response. Unattested issuance still succeeds until `LAKELORE_REQUIRE_ATTEST=1` (RUNBOOK §16). Telemetry: hourly `[attest]` log + `attest` in `/healthz?deep=1`. |
| `POST /api/feedback` | Capture in-app feedback | Appends one JSON line per submission to `/data/feedback.jsonl` on the volume. `message` 1–2000 chars, all other fields optional (strings clipped to 128 chars, numbers kept, anything else dropped — 2026-10-27). 20 submissions per IP per day per machine (`LAKELORE_FEEDBACK_PER_DAY`; 429 `feedback_quota`; with both machines serving, up to 40). Bodies capped at 16 KB (global `express.json` limit); the jsonl file is capped at 50 MB (503 `storage_full` beyond — truncate after export to recover). |
| `POST /api/:state/ask` | **Ask LakeLore** — natural-language lake search for **All-States subscribers** (2026-09-10; production launch with app 1.1.2, 2026-10-20) | A Claude tool-use loop (`server/ask.js`, Anthropic SDK `toolRunner`, model `claude-opus-5-5`, effort `medium`, both env-overridable via `LAKELORE_ASK_MODEL` / `LAKELORE_ASK_EFFORT` — switching model is one `flyctl secrets set`, RUNBOOK §20) over the SAME canonical handlers: the model can only call `search_lakes` (→ `canonical.results`, trimmed rows, ≤25) and `get_lake` (→ `canonical.lakeDetail`, summarized), so every lake it names is one a tool returned this turn. Body `{messages:[{role,content}]}`; the client resends the whole conversation — the server is stateless. **The server repairs irregular history instead of rejecting it (2026-10-27):** back-to-back turns from one side are merged, empty turns and a leading assistant turn dropped, earlier turns over 2,000 chars shortened, and the oldest question/answer pairs dropped to fit 20 turns / 12,000 chars. Still 400 `bad_request` (with a user-readable `message`): a malformed body, a history not ending with the user, a new question over 2,000 chars. **Whole-ask deadline** 45 s from request arrival (`LAKELORE_ASK_DEADLINE_MS`): the model loop is cancelled and the answer is a 200 "try a narrower question" (usage `stop_reason: "deadline"`; it counts as a question). A client that disconnects cancels the loop too, so no further model call is made; its question is given back only if no model call had finished. Response `{answer, answer_text, lakes[], usage}`: `answer` carries `[[lake_id\|Name]]` markers the app renders as tappable lake names from `lakes[]`; `answer_text` is the marker-free form the client sends back as history. **Route works only when `LAKELORE_ASK_ENABLED=1`** (503 `ask_unavailable` otherwise). **Subscribers only in every state, the free state included** (402 `subscription_required`; `LAKELORE_ASK_SUBSCRIBERS_ONLY=0` restores free-state asks — staging sets it, having no RevenueCat keys). In production mode the route is CLOSED (503) unless `LAKELORE_ASK_PUBLIC=1` (production) or `LAKELORE_ASK_TOKEN` is set and presented as `X-Ask-Token` (403 `ask_forbidden` otherwise; staging). Limits (2026-10-27): `LAKELORE_ASK_USER_DAILY_MAX` asks per subscriber per UTC day (default and production 15, per machine; 429 `ask_daily_quota`); user ids in the `LAKELORE_ASK_UNLIMITED_USERS` secret (comma list) skip that cap but still need a subscription. Off unless set: `LAKELORE_ASK_PER_HOUR` (asks per IP per hour; 429 `ask_quota`) and `LAKELORE_ASK_DAILY_MAX` (asks per machine per UTC day; 503 `ask_unavailable`). The startup log prints the limits in force (`[ask] limits — …`). Both daily counters are spent only after the body validates, are given back when the ask fails, and are saved to `$LAKELORE_DB_DIR/ask-counts.json` so a restart doesn't reset them. When the Anthropic credit balance or the Console workspace spend limit is exhausted, the API's 400 maps to 503 `ask_out_of_credit` with a "back next month" message (Sentry at most once per 6 h per machine); any other 4xx from the API is reported to Sentry too. Credentials: SDK default resolution (`ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login` profile); no credential → 503 `ask_unconfigured`. No user identifier is sent to Anthropic. Refusal fallbacks on (`fallbacks: "default"`). Per-state system prompt (~3.4k tokens for MN) is prompt-cached 1 h and dropped on `/reload`; since 2026-10-27 the request also sets top-level automatic caching (5 min), so the conversation and tool results already read are cache reads on the next loop call and the next question. The `X-Entitlement-Refresh: 1` rule from `/api/me/entitlement` applies here too since 2026-10-27, so a just-purchased user is re-checked rather than re-paywalled. Each ask logs one `[ask]` line + a JSONL record to `$LAKELORE_DB_DIR/ask-YYYY-MM-DD.jsonl` (`LAKELORE_ASK_LOG` names one exact file instead, for dev); log and report files older than 90 days are deleted at start-up and daily (the privacy policy promises 90 days); each file is capped at 50 MB. Dev servers also accept `{tool:{name,input}}` to run one tool with no model call. Terminal harness: `node bin/ask.js mn --base http://localhost:3100`. **Measured 2026-09-11 on Opus 5 (effort medium):** ~$0.03–0.05 per ask warm, ~$0.10 for the first ask per state per hour; Opus 5.5 is 20% cheaper per token ($4/$20 per MTok) — re-measure after launch. |
| `POST /api/:state/ask/report` | "Report this answer" from the chat (2026-10-20; Google Play AI-generated content policy) | Body `{reason, question, answer}` (clipped to 500 / 2000 / 8000 chars; `answer` required → 400 otherwise). Logs `[ask] REPORT`, then appends to `$LAKELORE_DB_DIR/ask-reports-YYYY-MM-DD.jsonl` (same 90-day pruning); 503 `ask_report_unavailable` when the file could not be written. No model call, so no entitlement or quota — its own per-IP limiter (20/h, `LAKELORE_ASK_REPORTS_PER_HOUR`; 429 `ask_report_quota`). 503 when `LAKELORE_ASK_ENABLED` is unset. |
| ~~`POST /api/subscribe`~~ | **Removed 2026-10-27 (SEC-02)** — was the marketing-site email capture; the site form was removed earlier and the privacy policy says there is no signup | Now the JSON 404. The old `/data/subscribers.jsonl` stays on each volume; `~/lakelore-data/bin/backup-userdata.sh` still sweeps it. |
| `GET /api/:state/lakes-index` | Lake-name index (id, name, county, per-lake counts) — feeds the app's lake-name typeahead | **Free state: public. Paid states: 402 without entitlement (2026-10-07; was public).** Names + counties + raw ids are the join key for every preview response, so the index is subscriber-only. Cached 6 h per state. |
| `POST /webhooks/revenuecat` | RevenueCat purchase-event webhook | Invalidates the per-user entitlement cache so `/api/me/entitlement` sees changes before the 5-min TTL. Auth: `Authorization` header compared byte-for-byte to `REVENUECAT_WEBHOOK_AUTH`; if the secret is unset, accepts unsigned events with a warning log. |


**Failure handling (all routes).** RevenueCat lookups have a deadline (`REVENUECAT_TIMEOUT_MS`, default 5000): a slow RevenueCat takes the same path as an error — known subscribers get the 72 h grace entitlement, others the preview, cached 30 s. Every 500 a route answers itself is also sent to Sentry through `server/report.js` (tags `handled`, `route`, `state`); before 2026-10-08 only uncaught errors reached Sentry. `/results` remembers each query's total per state until `/reload` (`cachedTotal` in `server/canonical.js`), so a repeat or paged search runs its join once instead of twice. `npm test` = `test/smoke.js` then `test/unit.js` (RevenueCat deadline, `/ask` gate, subscribers-only + per-subscriber quota, and against a fake Anthropic API: out-of-credit and spend-limit 503s, refunds, counts surviving a restart, 90-day pruning, `/ask/report`, client-config `ask` on and off).

## Hardening summary (2026-05-05)

- `app.set('trust proxy', 1)` — real client IP behind Fly's proxy
- Rate limit: 600 req / 15 min per IP, applied to `/api/*` only
- CORS allow-list: `lakeloreapp.com`, `www.lakeloreapp.com`, plus LAN dev origins; mobile native fetch (no Origin header) is unaffected
- `/api/:state/reload` requires bearer token in production
- Healthcheck on `/healthz` instead of `/api/mn/status`
