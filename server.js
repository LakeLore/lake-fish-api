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
const { gateByState, checkEntitlement, invalidateCache } = require('./entitlement');

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

// Active states served by this deployment. Every active state MUST be flagged
// canonical:true in the registry — there is no legacy serving path anymore.
// An active state the registry does not mark canonical is a CONFIG ERROR:
// logged loudly at startup and served as 503 (not a crash) so the other
// states stay up while the registry is fixed.
const ACTIVE_STATES = new Set(['mn', 'sd', 'nd', 'ia', 'ne']);
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

// DB path per state: {STATE}_DB_PATH env wins (production points at the Fly
// volume), else the lakelore-data artifact built by normalize.js.
function canonicalDbPath(state) {
  return process.env[`${state.toUpperCase()}_DB_PATH`]
    || path.join(__dirname, '..', 'lakelore-data', 'out', `${state}.db`);
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
app.use(express.json());

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
  res.json({ ok: true, states });
});

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
// 15-min from express-rate-limit, applied to /api. Body size is capped at
// 4 KB so abuse can't fill the volume.
//
// Future upgrade path: pipe submissions to email via Resend or Postmark, or
// surface them inside a dashboard. For v1 we just collect.
const FEEDBACK_LOG_PATH = process.env.FEEDBACK_LOG_PATH
  || path.join('/data', 'feedback.jsonl');

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
  fs.promises.mkdir(path.dirname(FEEDBACK_LOG_PATH), { recursive: true })
    .then(() => fs.promises.appendFile(FEEDBACK_LOG_PATH, JSON.stringify(entry) + '\n'))
    .then(() => res.json({ ok: true }))
    .catch(err => {
      console.warn('[feedback] write failed:', err.message);
      res.status(500).json({ error: 'write_failed' });
    });
});

// ── POST /webhooks/revenuecat ──────────────────────────────────────────────
// RevenueCat pushes purchase events here. We use them to invalidate the
// cache so subsequent /api/me/entitlement calls see the new state without
// waiting for the 5-min cache TTL. Verification: RC sends a configurable
// Authorization header value, which we compare to REVENUECAT_WEBHOOK_AUTH.

app.post('/webhooks/revenuecat', (req, res) => {
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (expected) {
    if (req.get('authorization') !== expected) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  } else {
    console.warn('[webhook] REVENUECAT_WEBHOOK_AUTH not set — accepting unsigned events');
  }
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
  if (!expected) return next();
  const auth = req.get('authorization') || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (presented !== expected) {
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
function computeLakeStockingMetrics(state, areaAcres, stockingRows) {
  if (!areaAcres || areaAcres <= 0 || !stockingRows?.length) {
    return { metrics: [], metrics_by_year: [] };
  }
  const survivingAdults = (species, lifeStage, stockYear, quantity, asOfDate) =>
    sharedSurvival.survivingAdults(species, lifeStage, stockYear, quantity, asOfDate, state);
  const acres100 = areaAcres / 100;
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

  const metrics_by_year = [];
  const currentBySpecies = new Map();
  for (const [k, totalAdults] of byKey) {
    const [species, yrStr] = k.split('|');
    const year = Number(yrStr);
    const val = Math.round((totalAdults / acres100) * 10) / 10;
    if (val <= 0) continue;
    metrics_by_year.push({ species, year, adults_per_100ac: val });
  }
  for (const [species, totalAdults] of headlineBySpecies) {
    const val = Math.round((totalAdults / acres100) * 10) / 10;
    if (val > 0) currentBySpecies.set(species, val);
  }
  metrics_by_year.sort((a, b) =>
    a.species === b.species ? a.year - b.year : a.species.localeCompare(b.species));

  const metrics = [...currentBySpecies.entries()]
    .map(([species, adults_per_100ac]) => ({ species, adults_per_100ac }))
    .sort((a, b) => b.adults_per_100ac - a.adults_per_100ac);

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
