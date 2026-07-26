'use strict';

// LakeLore API server — every active state serves through the canonical data
// layer (P5 cleanup, 2026-07): registry-driven handlers in server/canonical.js
// against canonical artifacts built by ../lakelore-data/bin/normalize.js.
// The legacy per-state code paths (per-state SQL branches, species maps,
// SD migrations, in-memory stocking metrics, per-state survival modules)
// were deleted after all five active states were parity-proven canonical —
// see ~/lakelore-data/reports/PARITY_NOTES.md ("P5 cleanup" section).
// ../lakelore-data (registry + schema assertion + shared survival) is a HARD
// startup requirement: if it is missing the process exits immediately.

// Sentry must be initialized BEFORE other requires so it can patch the
// modules they pull in (express, http, etc.) for auto-instrumentation.
// Quietly skips init if SENTRY_DSN is unset — local dev keeps working
// without it; production deploys set it as a Fly secret.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[sentry] SENTRY_DSN not set in production — error reporting disabled');
}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');
const { gateByState, checkEntitlement, invalidateCache, stats: entitlementStats, noteWebhook } = require('./entitlement');

// ── Canonical data layer (lakelore-data) — REQUIRED ────────────────────────────
// The registry (states.json), species map, canonical-schema assertion, and the
// shared survival model all live in ../lakelore-data. Without it the server
// cannot serve anything, so fail fast at startup (deploy-time), not per-request.
let lakeloreData, assertCanonicalSchema, canonical, sharedSurvival;
try {
  lakeloreData = require('../lakelore-data');
  lakeloreData.loadRegistry();
  assertCanonicalSchema = require('../lakelore-data/schema/assert-schema').assertSchema;
  sharedSurvival = require('../lakelore-data/survival');
  canonical = require('./server/canonical');
} catch (e) {
  console.error(`[fatal] lakelore-data unavailable — the server cannot start without the registry: ${e.message}`);
  process.exit(1);
}

// Active states served by this deployment — registry-driven (2026-07-15, the
// all-states launch): every state flagged active:true in
// lakelore-data/registry/states.json is served; the registry is the single
// source of truth (no more hand-mirrored literal). Every active state MUST be
// flagged canonical:true — there is no legacy serving path anymore. An active
// state the registry does not mark canonical is a CONFIG ERROR: logged loudly
// at startup and served as 503 (not a crash) so the other states stay up
// while the registry is fixed.
const ACTIVE_STATES = new Set(
  Object.entries(lakeloreData.loadRegistry().states)
    .filter(([, entry]) => entry.active === true)
    .map(([code]) => code)
);
console.log(`[startup] serving ${ACTIVE_STATES.size} active states from the registry`);
// Dev-only affordance: LAKELORE_ACTIVE_STATES_EXTRA=wi,mi lets a LOCAL run serve
// additional canonical:true states (e.g. staged-but-inactive WI/MI) for smoke
// testing WITHOUT editing the committed registry's active flags. Never set in
// production. Each extra state still must be canonical:true in the registry, or
// the config-error loop below flags it and its routes 503.
for (const s of (process.env.LAKELORE_ACTIVE_STATES_EXTRA || '')
  .split(',').map(x => x.trim()).filter(Boolean)) {
  ACTIVE_STATES.add(s);
}
const VALID_STATES = ACTIVE_STATES;

const _configErrorStates = new Set();
for (const state of ACTIVE_STATES) {
  let entry = null;
  try { entry = lakeloreData.getState(state); } catch { /* not in registry */ }
  if (!entry || entry.canonical !== true) {
    console.error(`[${state}] CONFIG ERROR: active state is not marked canonical:true in lakelore-data/registry/states.json — its routes will serve 503 until the registry is fixed`);
    _configErrorStates.add(state);
  }
}

// DB path per state: {STATE}_DB_PATH env wins, then LAKELORE_DB_DIR/{state}.db
// (production sets LAKELORE_DB_DIR=/data — one var covers the whole fleet),
// else the local lakelore-data artifact built by normalize.js.
function canonicalDbPath(state) {
  if (process.env[`${state.toUpperCase()}_DB_PATH`]) {
    return process.env[`${state.toUpperCase()}_DB_PATH`];
  }
  if (process.env.LAKELORE_DB_DIR) {
    return path.join(process.env.LAKELORE_DB_DIR, `${state}.db`);
  }
  return path.join(__dirname, '..', 'lakelore-data', 'out', `${state}.db`);
}

// States whose canonical DB failed startup schema validation. Their routes
// return 503 until a /reload re-validates successfully.
const _canonicalUnhealthy = new Set();

const PORT = process.env.PORT || 3100;
const STOCKING_CUTOFF_YEAR = new Date().getFullYear() - 10;

const app = express();

// Trust the Fly.io proxy so req.ip is the real client IP (not the edge IP)
// — required for per-IP rate limiting to work correctly behind a load balancer.
app.set('trust proxy', 1);

// CORS — open for the mobile app (which sends no Origin header), and for the
// marketing site fetching live state counts. Browser-based scraping from other
// origins gets blocked at the preflight.
const ALLOWED_BROWSER_ORIGINS = new Set([
  'https://lakeloreapp.com',
  'https://www.lakeloreapp.com',
]);
app.use(cors({
  origin(origin, cb) {
    // No Origin header → native mobile fetch or server-side fetch. Allow.
    if (!origin) return cb(null, true);
    if (ALLOWED_BROWSER_ORIGINS.has(origin)) return cb(null, true);
    // Local dev — Expo, Vite, Next.js dev server, LAN IPs.
    if (/^https?:\/\/(localhost(:\d+)?|127\.0\.0\.1(:\d+)?|192\.168\.\d+\.\d+(:\d+)?|10\.\d+\.\d+\.\d+(:\d+)?|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?)$/.test(origin)) {
      return cb(null, true);
    }
    // Disallowed: don't set Access-Control-Allow-Origin, but don't throw —
    // the browser will block the response, non-browser clients aren't
    // subject to CORS anyway. Letting it 500 was noisy and uninformative.
    cb(null, false);
  },
}));
// 16 KB body cap (2026-07-17, B11): the only JSON bodies we accept are
// feedback (≤2000-char message), subscribe (an email), and session attestation
// proofs (iOS App Attest CBOR ≈ 5-6 KB raw → ~8 KB base64, the sizing floor
// here). The express default of 100 KB let an unauthenticated writer grow the
// jsonl volume 6x faster than needed.
app.use(express.json({ limit: '16kb' }));

// Healthcheck — independent of any state DB, used by the Fly healthcheck.
// Kept outside /api so it bypasses rate limiting. Default shape is unchanged;
// ?deep=1 adds per-state freshness/health details.
app.get('/healthz', (req, res) => {
  if (req.query.deep !== '1') return res.json({ ok: true });
  const states = {};
  for (const state of ACTIVE_STATES) {
    const entry = { ok: false, lakes: null, generatedAt: null, ageDays: null };
    entry.schemaOk = null;
    if (_configErrorStates.has(state)) {
      entry.error = 'config error: active state not marked canonical in registry';
      states[state] = entry;
      continue;
    }
    try {
      const db = getDb(state);
      entry.schemaOk = !_canonicalUnhealthy.has(state);
      if (db) {
        entry.lakes = db.prepare('SELECT COUNT(*) as n FROM lakes').get().n;
        entry.ok = true;
        const g = db.prepare("SELECT value FROM meta WHERE key = 'generated_at'").get();
        if (g?.value) {
          entry.generatedAt = g.value;
          entry.ageDays = Math.round((Date.now() - Date.parse(g.value)) / 86400000 * 10) / 10;
        }
      }
    } catch (e) {
      entry.error = e.message;
    }
    states[state] = entry;
  }
  // Observability block (2026-07-25, T3.5/T3.3-lite): the hourly [sig]/[ver]/
  // [rc] log lines are the documented evidence for the RUNBOOK §16 enforcement
  // flips — and Fly's log buffer retains none of it. Cumulative counters +
  // memory/disk/jsonl gauges here make them probe-assertable from outside.
  let disk = null;
  try {
    const s = fs.statfsSync(process.env.LAKELORE_DB_DIR || '/data');
    disk = { freeMb: Math.round(s.bavail * s.bsize / 1048576), totalMb: Math.round(s.blocks * s.bsize / 1048576) };
  } catch { /* local dev without /data */ }
  const jsonl = {};
  for (const f of ['feedback.jsonl', 'subscribers.jsonl']) {
    try { jsonl[f] = fs.statSync(path.join(process.env.LAKELORE_DB_DIR || '/data', f)).size; } catch { /* absent */ }
  }
  res.json({
    ok: true, states,
    sig: { ..._sigStats },
    ver: Object.fromEntries(_verStats),
    attest: { ...require('./server/attest').stats },
    rc: { ...entitlementStats },
    memRssMb: Math.round(process.memoryUsage().rss / 1048576),
    disk, jsonl,
  });
});

// ── /readyz — data-aware readiness (IMPROVEMENT_PLAN 1.10) ─────────────────
// 200 only when EVERY active state serves (DB present, schema valid). For
// external uptime monitors and deploy-data.sh's post-restart gate; Fly's
// machine check stays on the cheap /healthz liveness probe so one bad state
// can't take the whole machine out of rotation.
//
// ?deep=1 (2026-07-17, B6) additionally EXECUTES a query against every state
// DB. The shallow check only proves the file opened at startup — a page that
// corrupts afterward 500s every request for that state while shallow /readyz
// stays green. Deep results are cached 60 s (56 full COUNT scans over small
// lakes tables ≈ cheap, but not per-probe cheap); deploy-data.sh polls deep.
// Execute the REAL results + lake-detail handlers for one lake of one state
// with a mock req/res (better-sqlite3 is synchronous, so both handlers
// complete inline). Returns null on success or a short failure tag.
function _mockRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  r.set = () => r; r.setHeader = () => r; r.type = () => r;
  return r;
}
function probeState(state) {
  const db = getDb(state);
  if (!db) return 'no-db';
  // Prefer a lake that actually has catch rows (exercises the full catches
  // projection), and skip blank/whitespace ids (IN carries a lake with
  // id=' ' — a raw-source artifact that 400s by design).
  const lake = db.prepare(`SELECT lake_id AS id FROM fish_catch WHERE length(trim(lake_id)) > 0 LIMIT 1`).get()
    ?? db.prepare(`SELECT id FROM lakes WHERE length(trim(id)) > 0 LIMIT 1`).get();
  if (!lake) return 'no-lakes';
  const mkReq = (params, query) => ({ params, query, get: () => undefined, lakeLorePreview: false, ip: 'probe' });
  let r = _mockRes();
  canonical.results(mkReq({ state }, { pageSize: '1' }), r, canonicalCtx);
  if (r.statusCode !== 200) return `results:${r.statusCode}`;
  r = _mockRes();
  canonical.lakeDetail(mkReq({ state, id: String(lake.id) }, {}), r, canonicalCtx);
  if (r.statusCode !== 200) return `lake:${r.statusCode}`;
  return null;
}

let _deepReadyCache = { at: 0, bad: null };
app.get('/readyz', (req, res) => {
  const deep = req.query.deep === '1';
  let bad;
  if (deep && Date.now() - _deepReadyCache.at < 60_000) {
    bad = _deepReadyCache.bad;
  } else {
    bad = [];
    for (const state of ACTIVE_STATES) {
      if (_configErrorStates.has(state)) { bad.push(`${state}:config`); continue; }
      try {
        const db = getDb(state);
        if (!db) { bad.push(`${state}:no-db`); continue; }
        if (_canonicalUnhealthy.has(state)) { bad.push(`${state}:schema`); continue; }
        if (deep) {
          // Real wire-projection probe (2026-07-25, T3.2 — was COUNT(*)): the
          // projection assembled from registry wire lists THROWS on any
          // unmapped field, 500ing /results and /lake while a COUNT stays
          // green. Execute the actual handlers against one lake per state.
          const probeErr = probeState(state);
          if (probeErr) { bad.push(`${state}:${probeErr}`); continue; }
        }
      } catch (e) {
        bad.push(`${state}:${e.message.slice(0, 40)}`);
      }
    }
    if (deep) _deepReadyCache = { at: Date.now(), bad };
  }
  if (bad.length) return res.status(503).json({ ready: false, deep, bad });
  res.json({ ready: true, deep, states: ACTIVE_STATES.size });
});

// ── Client identity signature (IMPROVEMENT_PLAN 1.8 scaffolding) ────────────
// gateByState trusts a raw X-User-Id header; a hostile caller who OBTAINS a
// subscriber's RC id gets paid access. 1.1.0+ clients also send
// X-User-Sig = HMAC-SHA256(userId, embedded key). Enforcement is LOG-ONLY
// until the 1.0.x fleet drains (they can't send it) — flip
// LAKELORE_REQUIRE_USER_SIG=1 to enforce once adoption allows. This raises
// the bar from "copy a header" to "extract a key from the app binary"; full
// signed-token auth remains the long-term item.
const USER_SIG_KEY = process.env.LAKELORE_USER_SIG_KEY || 'lakelore-client-v1';
const nodeCrypto = require('crypto');
// Telemetry for the enforcement flip: the flip is safe when `unsigned` is
// ~0 over a sustained window (the 1.0.x fleet has drained). Counters reset
// hourly with a summary log line; live totals ride /healthz?deep=1 as `sig`.
const _sigStats = { signed: 0, unsigned: 0, invalid: 0, since: Date.now() };
setInterval(() => {
  const mins = Math.round((Date.now() - _sigStats.since) / 60000);
  console.log(`[sig] last ${mins}m: signed=${_sigStats.signed} unsigned=${_sigStats.unsigned} invalid=${_sigStats.invalid}`
    + (_sigStats.unsigned === 0 && _sigStats.signed > 0 ? ' — unsigned traffic drained; LAKELORE_REQUIRE_USER_SIG=1 is safe if this holds' : ''));
  _sigStats.signed = 0; _sigStats.unsigned = 0; _sigStats.invalid = 0; _sigStats.since = Date.now();
}, 60 * 60 * 1000).unref();
// ── Client version histogram (2026-07-25, T1.2) ────────────────────────────
// 1.1.1+ clients send X-App-Version: <version>+<build> (and X-Update-Id for
// the OTA bundle). This makes "has the old fleet drained?" measurable — the
// documented precondition for flipping LAKELORE_REQUIRE_USER_SIG / _TOKEN /
// _ATTEST — instead of asserted. Hourly summary line, same pattern as [sig].
const _verStats = new Map();
let _verNoHeader = 0;
setInterval(() => {
  if (_verStats.size > 0 || _verNoHeader > 0) {
    const top = [..._verStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([v, n]) => `${v}=${n}`).join(' ');
    console.log(`[ver] last hour: ${top}${_verNoHeader ? ` no-header=${_verNoHeader} (pre-1.1.1 fleet)` : ''}`);
  }
  _verStats.clear(); _verNoHeader = 0;
}, 60 * 60 * 1000).unref();
app.use((req, res, next) => {
  if (req.get('x-user-id')) {
    const v = req.get('x-app-version');
    if (v) _verStats.set(v, (_verStats.get(v) || 0) + 1);
    else _verNoHeader++;
  }
  next();
});

app.use((req, res, next) => {
  const userId = req.get('x-user-id');
  if (!userId) return next();
  const sig = req.get('x-user-sig');
  const expected = nodeCrypto.createHmac('sha256', USER_SIG_KEY).update(userId).digest('hex').slice(0, 32);
  const valid = sig === expected;
  req.lakeLoreSigValid = valid;
  if (valid) _sigStats.signed++;
  else if (sig) _sigStats.invalid++;
  else _sigStats.unsigned++;
  if (!valid && process.env.LAKELORE_REQUIRE_USER_SIG === '1') {
    return res.status(401).json({ error: 'invalid_client_signature' });
  }
  if (sig && !valid) console.warn(`[sig] BAD signature for user ${userId.slice(0, 8)}… (${req.path})`);
  next();
});

// ── Session tokens (IMPROVEMENT_PLAN 1.8, the long-term item) ───────────────
// Server-issued HS256 tokens bind the entitlement identity to a SERVER-ONLY
// secret: expiry (7d), server-side rotation (rotate LAKELORE_JWT_SECRET), and
// a future hard-enforcement point (LAKELORE_REQUIRE_TOKEN=1, same drain-gated
// flip as the client signature). Issuance is bootstrapped on x-user-id + a
// VALID x-user-sig; a verified Bearer token then becomes the AUTHORITATIVE
// identity — the middleware overwrites x-user-id with the token's subject so
// every downstream consumer (gateByState, /api/me, feedback) transparently
// uses the verified id. A present-but-invalid token is always a 401.
// Honest limit: without platform attestation (App Attest / Play Integrity —
// the documented next step), issuance trust still roots in the embedded
// client key; what this adds is rotation, expiry, and the enforcement point.
const JWT_SECRET = process.env.LAKELORE_JWT_SECRET || 'lakelore-dev-jwt-secret';
// Refuse to serve production traffic with the repo-known default JWT key: a
// secrets mishap would otherwise make session tokens forgeable — and the
// preview-id key (server/canonical.js) is derived from this secret too, so
// losing it would also make preview lake ids offline-reversible. NOTHING else
// would fail or warn. (USER_SIG_KEY is intentionally exempt — its default is
// the client-embedded value.)
if (process.env.NODE_ENV === 'production' && !process.env.LAKELORE_JWT_SECRET) {
  console.error("FATAL: production requires LAKELORE_JWT_SECRET — refusing to start with the repo-default key. Set it via 'flyctl secrets set'.");
  process.exit(1);
}
const TOKEN_TTL_S = 7 * 24 * 60 * 60;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function signToken(sub, att = 'none') {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ sub, att, iat: now, exp: now + TOKEN_TTL_S }));
  const sig = nodeCrypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
function verifyToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expect = nodeCrypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(parts[2]); const b = Buffer.from(expect);
  if (a.length !== b.length || !nodeCrypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.sub || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// (Session route + bearer verification are registered AFTER the rate
// limiter below so token minting is rate-limited too.)

// Rate limiting — 600 req per 15 min per IP in production.
// One typical session uses ~10–15 requests; 600 covers ~40 sessions per
// rolling 15 min from a single IP, with comfortable headroom for shared NATs.
if (process.env.NODE_ENV === 'production') {
  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  }));
}

// ── GET /api/client-config (2026-07-25, T1.1) ───────────────────────────────
// The upgrade-nudge / kill-switch lever that did not exist for any shipped
// version: 1.1.1+ clients fetch this on launch/foreground. All values are env
// vars so flipping them is `flyctl secrets set` (or `fly machine update -e`) —
// no image deploy needed.
//   LAKELORE_MIN_APP_VERSION   e.g. "1.2.0"  → older clients see a dismissible
//                              "please update" prompt.
//   LAKELORE_KILLED_VERSIONS   comma list, e.g. "1.1.1" → those exact versions
//                              see a BLOCKING update screen (bad-release kill switch).
//   LAKELORE_UPGRADE_MESSAGE   optional custom copy for either prompt.
app.get('/api/client-config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    minVersion: process.env.LAKELORE_MIN_APP_VERSION || null,
    killedVersions: (process.env.LAKELORE_KILLED_VERSIONS || '')
      .split(',').map(s => s.trim()).filter(Boolean),
    message: process.env.LAKELORE_UPGRADE_MESSAGE || null,
  });
});

// Session-token issuance + bearer verification (helpers defined above).
// Platform attestation (App Attest / Play Integrity) rides the same route:
// clients fetch a challenge, attest it on-device, and attach the proof to the
// POST. Verified proofs stamp an `att` claim on the token; unattested
// requests still succeed until LAKELORE_REQUIRE_ATTEST=1 (drain-gated on the
// [attest] telemetry — ~/RUNBOOK.md §16). Verification lives in
// server/attest.js.
const attest = require('./server/attest');
setInterval(attest.logAndResetStats, 60 * 60 * 1000).unref();

app.get('/api/session/challenge', (req, res) => {
  const userId = req.get('x-user-id');
  if (!userId || userId.length > 128) return res.status(400).json({ error: 'missing_x_user_id' });
  if (!req.lakeLoreSigValid) return res.status(401).json({ error: 'invalid_client_signature' });
  res.json({ challenge: attest.makeChallenge(userId), expiresIn: 600 });
});

app.post('/api/session', async (req, res) => {
  const userId = req.get('x-user-id');
  if (!userId || userId.length > 128) return res.status(400).json({ error: 'missing_x_user_id' });
  if (!req.lakeLoreSigValid) return res.status(401).json({ error: 'invalid_client_signature' });

  let att = 'none';
  const body = req.body ?? {};
  if (body.platform === 'ios' || body.platform === 'android') {
    if (!attest.checkChallenge(userId, body.challenge)) {
      attest.stats.bad_challenge++;
    } else if (body.platform === 'ios') {
      const v = await attest.verifyIos({
        keyId: body.keyId, attestation: body.attestation, challenge: body.challenge,
      });
      if (v.ok) { att = 'ios'; attest.stats.ios_ok++; }
      else {
        attest.stats.ios_fail++;
        console.warn(`[attest] ios verify failed (${v.reason}) for ${userId.slice(0, 8)}…`);
      }
    } else {
      const v = await attest.verifyAndroid({ token: body.token, challenge: body.challenge });
      if (v.ok) { att = 'android'; attest.stats.android_ok++; }
      else if (v.reason === 'not_configured') attest.stats.android_unavailable++;
      else {
        attest.stats.android_fail++;
        console.warn(`[attest] android verify failed (${v.reason}) for ${userId.slice(0, 8)}…`);
      }
    }
  } else {
    attest.stats.none++;
  }

  if (att === 'none' && process.env.LAKELORE_REQUIRE_ATTEST === '1') {
    return res.status(401).json({ error: 'attestation_required' });
  }
  const token = signToken(userId, att);
  res.json({ token, expiresIn: TOKEN_TTL_S, attested: att !== 'none' });
});

app.use((req, res, next) => {
  // /webhooks/* (RC's own Authorization value) and /reload (RELOAD_TOKEN
  // bearer) carry NON-session Authorization headers — never parse those here.
  if (req.path.startsWith('/webhooks') || /^\/api\/[a-z]{2}\/reload$/.test(req.path)) return next();
  const auth = req.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    if (process.env.LAKELORE_REQUIRE_TOKEN === '1' && req.get('x-user-id') && req.path !== '/api/session') {
      return res.status(401).json({ error: 'session_token_required' });
    }
    return next();
  }
  const payload = verifyToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: 'invalid_session_token' });
  req.headers['x-user-id'] = payload.sub;
  req.lakeLoreAuth = 'token';
  next();
});

// Subscription gate — applied to /api/{paid-state}/* routes. Free state
// (MN) passes through; paid states require the `LakeLore All-States`
// entitlement on the user identified by X-User-Id. Skips POST /reload
// (admin endpoint, already token-protected) and /api/me/* (the
// entitlement-status endpoint itself).
app.use(gateByState);

// ── /api/me/entitlement ────────────────────────────────────────────────────
// Mobile app calls this on launch to know whether to render gated state UI.
// The server is the authoritative source — RC SDK on-device is the same
// data, but a hostile client could tamper with that, so the server checks
// independently against RevenueCat.

app.get('/api/me/entitlement', async (req, res) => {
  const userId = req.get('x-user-id');
  if (!userId) return res.status(400).json({ error: 'missing_x_user_id' });
  try {
    const result = await checkEntitlement(userId);
    res.json({
      hasAllStates: result.hasAllStates,
      expiresAt: result.expiresAt,
      source: result.source,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/feedback ─────────────────────────────────────────────────────
// In-app feedback form. Mobile app posts a user-typed message plus context
// (lake, state, species, tab, app version). We append one JSON line per
// submission to /data/feedback.jsonl on the Fly volume. Triage by reading
// the file (cat / grep / jq).
//
// No auth: anyone with the app can submit. Rate limit is the global 600/
// 15-min from express-rate-limit, applied to /api; bodies are capped at 16 KB
// by the express.json limit, and the file itself is capped below so a
// sustained distributed writer can't fill the volume.
//
// Future upgrade path: pipe submissions to email via Resend or Postmark, or
// surface them inside a dashboard. For v1 we just collect.
const FEEDBACK_LOG_PATH = process.env.FEEDBACK_LOG_PATH
  || path.join('/data', 'feedback.jsonl');

// Append with a hard per-file byte cap (2026-07-17, B11). 50 MB ≈ hundreds of
// thousands of entries — legitimate traffic never gets near it, and a filled
// file degrades to a clean 503 instead of exhausting the 1 GB data volume the
// state DBs live on. The weekly backup-userdata.sh sweep keeps offsite copies,
// so truncating a capped file after export is safe recovery.
const JSONL_MAX_BYTES = 50 * 1024 * 1024;
async function appendJsonlCapped(p, entry) {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const size = await fs.promises.stat(p).then(s => s.size).catch(() => 0);
  if (size > JSONL_MAX_BYTES) {
    const err = new Error('jsonl cap reached');
    err.capped = true;
    throw err;
  }
  await fs.promises.appendFile(p, JSON.stringify(entry) + '\n');
}

app.post('/api/feedback', (req, res) => {
  const userId = req.get('x-user-id') || null;
  const { message, lakeId, lakeName, state, species, tab, version, build } = req.body || {};
  if (typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message_required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'message_too_long' });
  }
  const entry = {
    ts: new Date().toISOString(),
    userId,
    state: state ?? null,
    lakeId: lakeId ?? null,
    lakeName: lakeName ?? null,
    species: species ?? null,
    tab: tab ?? null,
    version: version ?? null,
    build: build ?? null,
    message: message.trim(),
  };
  appendJsonlCapped(FEEDBACK_LOG_PATH, entry)
    .then(() => res.json({ ok: true }))
    .catch(err => {
      console.warn('[feedback] write failed:', err.message);
      res.status(err.capped ? 503 : 500).json({ error: err.capped ? 'storage_full' : 'write_failed' });
    });
});

// ── POST /api/subscribe ─────────────────────────────────────────────────────
// Marketing-site email capture (IMPROVEMENT_PLAN P3.2): appends to a JSONL on
// the volume — export with `fly ssh console -C "cat /data/subscribers.jsonl"`.
const SUBSCRIBERS_PATH = process.env.SUBSCRIBERS_PATH
  || (process.env.LAKELORE_DB_DIR ? path.join(process.env.LAKELORE_DB_DIR, 'subscribers.jsonl')
    : path.join(__dirname, 'data', 'subscribers.jsonl'));
app.post('/api/subscribe', (req, res) => {
  const { email, state, source } = req.body || {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 320) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  const entry = {
    ts: new Date().toISOString(),
    email: email.trim().toLowerCase(),
    state: typeof state === 'string' ? state.slice(0, 8) : null,
    source: typeof source === 'string' ? source.slice(0, 64) : null,
  };
  appendJsonlCapped(SUBSCRIBERS_PATH, entry)
    .then(() => res.json({ ok: true }))
    .catch(err => {
      console.warn('[subscribe] write failed:', err.message);
      res.status(err.capped ? 503 : 500).json({ error: err.capped ? 'storage_full' : 'write_failed' });
    });
});

// ── GET /api/:state/lakes-index — public SEO index (IMPROVEMENT_PLAN P3.1) ──
// Lake NAMES + counts only, no metrics: powers the marketing site's
// programmatic per-lake pages ("teaser + paywall pitch" for paid states —
// the name is the search term, the numbers stay in the app/behind the sub).
// Free-state pages additionally pull full data from the already-public
// /results. Registered BEFORE gateByState-sensitive ordering is irrelevant —
// this path isn't in the gated regex. Cached in-memory per state.
const _lakesIndexCache = new Map(); // state -> { at, body }
app.get('/api/:state/lakes-index', (req, res) => {
  if (!validateState(req, res)) return;
  const { state } = req.params;
  const cached = _lakesIndexCache.get(state);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return res.json(cached.body);
  try {
    const db = getDb(state);
    if (!db) return res.status(503).json({ error: 'not ready' });
    const rows = db.prepare(`
      SELECT l.id, l.name, l.county,
             (SELECT COUNT(*) FROM surveys s WHERE s.lake_id = l.id) AS surveys,
             (SELECT COUNT(DISTINCT fc.species_native) FROM fish_catch fc WHERE fc.lake_id = l.id) AS species,
             (SELECT COUNT(*) FROM stocking st WHERE st.lake_id = l.id) AS stocking_events
      FROM lakes l ORDER BY l.name
    `).all();
    const body = { state, count: rows.length, lakes: rows };
    _lakesIndexCache.set(state, { at: Date.now(), body });
    res.json(body);
  } catch (err) {
    console.error(`[${state}] /lakes-index error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhooks/revenuecat ──────────────────────────────────────────────
// RevenueCat pushes purchase events here. We use them to invalidate the
// cache so subsequent /api/me/entitlement calls see the new state without
// waiting for the 5-min cache TTL. Verification: RC sends a configurable
// Authorization header value, which we compare to REVENUECAT_WEBHOOK_AUTH.

// Constant-time secret comparison (2026-07-25, T3.6). Hash both sides first
// so the length is not observable either.
function secretEq(presented, expected) {
  const h = (s) => nodeCrypto.createHash('sha256').update(String(s)).digest();
  return nodeCrypto.timingSafeEqual(h(presented), h(expected));
}

app.post('/webhooks/revenuecat', (req, res) => {
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (expected) {
    if (!secretEq(req.get('authorization') || '', expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    // Fail CLOSED (2026-07-25, T3.6 — was warn + accept): with the secret
    // unset, an unauthenticated caller could force entitlement-cache
    // invalidations at will. A missing secret in production is a config
    // error, not a reason to trust the internet.
    console.error('[webhook] REVENUECAT_WEBHOOK_AUTH not set in production — REJECTING unsigned events (entitlement freshness degrades to the 5-min TTL until the secret is restored)');
    return res.status(503).json({ error: 'webhook_auth_unconfigured' });
  } else {
    console.warn('[webhook] REVENUECAT_WEBHOOK_AUTH not set — accepting unsigned events (dev only)');
  }
  noteWebhook();
  const userId = req.body?.event?.app_user_id;
  if (userId) {
    invalidateCache(userId);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[webhook] cache invalidated for ${userId} (event: ${req.body?.event?.type})`);
    }
  }
  res.json({ ok: true });
});

// /reload guard — if RELOAD_TOKEN is set in the environment, callers must
// present it as `Authorization: Bearer <token>`. Local dev (no token set)
// stays unauthenticated so fetch.sh keeps working.
function requireReloadToken(req, res, next) {
  const expected = process.env.RELOAD_TOKEN;
  if (!expected) {
    // Fail CLOSED in production (2026-07-25, T3.6 — was fail-open): an
    // accidental `secrets unset` silently made /reload public before.
    // Local dev (no token set) stays unauthenticated so fetch.sh works.
    if (process.env.NODE_ENV === 'production') {
      console.error('[reload] RELOAD_TOKEN not set in production — refusing /reload');
      return res.status(503).json({ error: 'reload_token_unconfigured' });
    }
    return next();
  }
  const auth = req.get('authorization') || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!secretEq(presented, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const NE_PDF_DIR = process.env.NE_PDF_DIR ||
  path.join(__dirname, '..', 'ne-lake-fish', 'data', 'pdfs');

// ── Species resolution (registry) ──────────────────────────────────────────────
// species_native -> canonical code via lakelore-data/registry/species.json.

const _speciesResolvers = {};
function resolveSpeciesCode(state, rawSpecies) {
  if (!rawSpecies) return null;
  const resolver = _speciesResolvers[state]
    || (_speciesResolvers[state] = lakeloreData.speciesResolver(state));
  return resolver(rawSpecies).code;
}

// Compute current and per-year stocking metrics for one lake on the fly.
// Used by /lake/:id so the headline (current adults_per_100ac) and chart
// (per-year line) always come from the same survival model — the shared
// lakelore-data survival module (equivalence-proven against every legacy
// per-state module), bound to the state's life-stage normalization rules.
//
// Lakes WITHOUT usable acreage (2026-07-15): the same math runs without the
// denominator — every metric row carries `adults_est` (absolute estimated
// survivors) and `adults_per_100ac: null`. Lakes WITH acreage carry both
// (adults_est is additive info; the shipped-app contract of numeric
// adults_per_100ac is unchanged for them).
//
// `allowAbsolute` comes from the client's `metricsV2=1` query param: shipped
// 1.0.x builds call `.toFixed()` on adults_per_100ac unguarded, so a null
// there would crash their stock-year popup — they keep the legacy empty
// metrics for acreage-less lakes.
function computeLakeStockingMetrics(state, areaAcres, stockingRows, allowAbsolute = false) {
  if (!stockingRows?.length) {
    return { metrics: [], metrics_by_year: [] };
  }
  const hasArea = !!areaAcres && areaAcres > 0;
  if (!hasArea && !allowAbsolute) {
    return { metrics: [], metrics_by_year: [] };
  }
  const survivingAdults = (species, lifeStage, stockYear, quantity, asOfDate) =>
    sharedSurvival.survivingAdults(species, lifeStage, stockYear, quantity, asOfDate, state);
  const acres100 = hasArea ? areaAcres / 100 : null;
  const today = new Date();
  const currentYear = today.getFullYear();

  const recent = stockingRows
    .filter(r => r.stock_year >= STOCKING_CUTOFF_YEAR)
    .map(r => ({ ...r, _code: resolveSpeciesCode(state, r.species) }))
    .filter(r => r._code);
  if (!recent.length) return { metrics: [], metrics_by_year: [] };

  const firstYear = Math.min(...recent.map(r => r.stock_year));
  const byKey = new Map(); // `${species}|${year}` -> total surviving adults

  // Chart points: anchor every year at Dec 31 so each year's value is
  // "adults by end of Y". Consistent anchoring means each year of elapsed
  // time multiplies survival once — the year-over-year decline matches the
  // model's annual adult survival rate. (Earlier this anchored past years
  // at Dec 31 but current year at today, which produced identical 2025/2026
  // values when viewed before July: 2025-12-31 and 2026-05-20 both round
  // down to the same `completeYears` count.)
  for (let y = firstYear; y <= currentYear; y++) {
    const asOf = new Date(`${y}-12-31`);
    for (const r of recent) {
      if (r.stock_year > y) continue;
      const adults = survivingAdults(r._code, r.life_stage, r.stock_year, r.quantity, asOf);
      if (adults <= 0) continue;
      const k = `${r.species}|${y}`;
      byKey.set(k, (byKey.get(k) || 0) + adults);
    }
  }

  // Headline: "adults alive right now". Computed separately at today's date
  // so the stat pill reflects the live population, not a year-end projection.
  const headlineBySpecies = new Map();
  for (const r of recent) {
    const adults = survivingAdults(r._code, r.life_stage, r.stock_year, r.quantity, today);
    if (adults <= 0) continue;
    headlineBySpecies.set(r.species, (headlineBySpecies.get(r.species) || 0) + adults);
  }

  const round1 = (v) => Math.round(v * 10) / 10;
  const metrics_by_year = [];
  const currentBySpecies = new Map(); // species -> { per100ac, est }
  for (const [k, totalAdults] of byKey) {
    const [species, yrStr] = k.split('|');
    const year = Number(yrStr);
    const est = round1(totalAdults);
    const per = hasArea ? round1(totalAdults / acres100) : null;
    if ((hasArea ? per : est) <= 0) continue;
    metrics_by_year.push({ species, year, adults_per_100ac: per, adults_est: est });
  }
  for (const [species, totalAdults] of headlineBySpecies) {
    const est = round1(totalAdults);
    const per = hasArea ? round1(totalAdults / acres100) : null;
    if ((hasArea ? per : est) > 0) currentBySpecies.set(species, { per, est });
  }
  metrics_by_year.sort((a, b) =>
    a.species === b.species ? a.year - b.year : a.species.localeCompare(b.species));

  const metrics = [...currentBySpecies.entries()]
    .map(([species, v]) => ({ species, adults_per_100ac: v.per, adults_est: v.est }))
    .sort((a, b) => (b.adults_per_100ac ?? b.adults_est) - (a.adults_per_100ac ?? a.adults_est));

  return { metrics, metrics_by_year };
}

// ── Database connections (one per state, lazy, read-only) ──────────────────────

const _dbs = {};

// Open the lakelore-data artifact read-only and validate its schema on first
// open. On mismatch: mark unhealthy, log loudly, do NOT crash — that state's
// routes return 503 until /reload re-validates.
function getCanonicalDb(state) {
  const dbPath = canonicalDbPath(state);
  if (!fs.existsSync(dbPath)) return null;
  // No journal_mode pragma here: canonical artifacts are immutable snapshots
  // (built with journal_mode=OFF), and changing the mode on a readonly handle
  // would attempt a write.
  const db = new Database(dbPath, { readonly: true });
  try {
    const problems = assertCanonicalSchema(db);
    if (problems.length) {
      _canonicalUnhealthy.add(state);
      console.error(`[${state}] canonical schema mismatch (${problems.length} problem${problems.length === 1 ? '' : 's'}) at ${dbPath}:`);
      for (const p of problems.slice(0, 10)) console.error(`  - ${p}`);
      db.close();
      return null;
    }
  } catch (e) {
    _canonicalUnhealthy.add(state);
    console.error(`[${state}] canonical schema validation failed at ${dbPath}: ${e.message}`);
    try { db.close(); } catch {}
    return null;
  }
  _canonicalUnhealthy.delete(state);
  _dbs[state] = db;
  return db;
}

function getDb(state) {
  if (_dbs[state]) return _dbs[state];
  return getCanonicalDb(state);
}

// ── Route guard ───────────────────────────────────────────────────────────────

function validateState(req, res) {
  const state = req.params.state;
  if (!VALID_STATES.has(state)) {
    res.status(400).json({ error: `Unknown state: ${state}` });
    return false;
  }
  if (_configErrorStates.has(state)) {
    res.status(503).json({ error: 'state misconfigured: active but not marked canonical in registry' });
    return false;
  }
  return true;
}

// Context handed to the generic canonical handlers (server/canonical.js).
const canonicalCtx = {
  getDb,
  isUnhealthy: (state) => _canonicalUnhealthy.has(state),
  getStateEntry: (state) => lakeloreData.getState(state),
  computeLakeStockingMetrics,
};

// ── /api/:state/status ─────────────────────────────────────────────────────────

app.get('/api/:state/status', (req, res) => {
  if (!validateState(req, res)) return;
  const { state } = req.params;
  const db = getDb(state);
  if (_canonicalUnhealthy.has(state)) {
    return res.status(503).json({ error: 'state unhealthy: schema mismatch' });
  }
  if (!db) return res.json({ ready: false, message: 'Database not found' });

  try {
    const lakes = db.prepare('SELECT COUNT(*) as n FROM lakes').get().n;
    const hasSurveys = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='surveys'").get();
    const hasCatch   = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fish_catch'").get();
    const surveys = hasSurveys ? db.prepare('SELECT COUNT(*) as n FROM surveys').get().n : 0;
    const catches = hasCatch   ? db.prepare('SELECT COUNT(*) as n FROM fish_catch').get().n : 0;
    res.json({ ready: true, lakes, surveys, catches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/:state/filters ────────────────────────────────────────────────────────

app.get('/api/:state/filters', (req, res) => {
  if (!validateState(req, res)) return;
  return canonical.filters(req, res, canonicalCtx);
});

// ── /api/:state/measures ─────────────────────────────────────────────────────
// Measure × Gear/Source manifest (DATA_MODEL_PROPOSAL_2026-07-20). The app builds
// its Measure selector + Gear/Source filter from this: a stable set of measures
// (Abundance / Avg Size / Stocking Impact / Presence) with the gear/source
// options nested under the ones that require them.
app.get('/api/:state/measures', (req, res) => {
  if (!validateState(req, res)) return;
  return canonical.measures(req, res, canonicalCtx);
});

// ── /api/:state/results ────────────────────────────────────────────────────────

app.get('/api/:state/results', (req, res) => {
  if (!validateState(req, res)) return;
  return canonical.results(req, res, canonicalCtx);
});

// ── /api/:state/lake/:id ───────────────────────────────────────────────────────

app.get('/api/:state/lake/:id', (req, res) => {
  if (!validateState(req, res)) return;
  return canonical.lakeDetail(req, res, canonicalCtx);
});

// ── /api/:state/reload ────────────────────────────────────────────────────────
// Drops and reopens the DB connection for one state so fresh data is served
// immediately after a normalize + upload — no server restart needed.
// Safe to call in production (rate-limited, read-only data, single-threaded).

app.post('/api/:state/reload', requireReloadToken, (req, res) => {
  if (!validateState(req, res)) return;
  const { state } = req.params;

  // Close and evict cached DB connection
  if (_dbs[state]) {
    try { _dbs[state].close(); } catch {}
    delete _dbs[state];
  }

  // Drop the cached preview-id reverse map: the replaced artifact may have
  // added lakes, and a stale map 404s /lake/:id for preview users tapping a
  // new lake until a full restart (defeating /reload's whole purpose).
  canonical.clearPreviewLakeIdMap(state);

  // Clear the unhealthy flag so the reopen re-validates the (possibly
  // replaced) artifact's schema from scratch.
  _canonicalUnhealthy.delete(state);

  const db = getDb(state);
  if (!db) {
    if (_canonicalUnhealthy.has(state)) {
      return res.status(503).json({ error: 'state unhealthy: schema mismatch' });
    }
    return res.status(503).json({ error: `Database not found at ${canonicalDbPath(state)}` });
  }

  try {
    const lakes = db.prepare('SELECT COUNT(*) as n FROM lakes').get().n;
    console.log(`[${state}] reloaded — ${lakes} lakes`);
    res.json({ ok: true, state, lakes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/ne/pdf/:name ──────────────────────────────────────────────────────────
// Nebraska survey PDFs are stored locally; proxy them through the API.

app.get('/api/ne/pdf/:name', (req, res) => {
  const name = path.basename(req.params.name); // prevent path traversal
  const filePath = path.join(NE_PDF_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ── Sentry Express error handler ───────────────────────────────────────────────
// Must be registered AFTER all routes. No-ops if Sentry wasn't initialized.

if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ── Startup ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Lake Fish mobile server running on port ${PORT}`);
  console.log(`Routes: /api/{${[...ACTIVE_STATES].join('|')}}/{status|filters|results|lake/:id}`);

  // Pre-warm: open each active state's DB (validates schema) and log lake count.
  for (const state of ACTIVE_STATES) {
    if (_configErrorStates.has(state)) {
      console.error(`  [${state}] CONFIG ERROR — active but not canonical in registry; routes will 503`);
      continue;
    }
    const db = getDb(state);
    if (db) {
      try {
        const n = db.prepare('SELECT COUNT(*) as n FROM lakes').get().n;
        console.log(`  [${state}] ready — ${n} lakes (canonical)`);
      } catch (e) {
        console.warn(`  [${state}] startup warning: ${e.message}`);
      }
    } else if (_canonicalUnhealthy.has(state)) {
      console.error(`  [${state}] UNHEALTHY — canonical schema mismatch, routes will 503`);
    } else {
      console.log(`  [${state}] database not found — skipping`);
    }
  }
});
