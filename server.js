'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');

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
// Kept outside /api so it bypasses rate limiting.
app.get('/healthz', (req, res) => res.json({ ok: true }));

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

// ── State database paths (override with env vars in production) ────────────────

const STATE_DB_PATHS = {
  mn: process.env.MN_DB_PATH || path.join(__dirname, '..', 'mn-lake-fish', 'data', 'lakes.db'),
  sd: process.env.SD_DB_PATH || path.join(__dirname, '..', 'sd-lake-fish', 'data', 'sd_lakes.db'),
  nd: process.env.ND_DB_PATH || path.join(__dirname, '..', 'nd-lake-fish', 'data', 'lakes.db'),
  ia: process.env.IA_DB_PATH || path.join(__dirname, '..', 'ia-lake-fish', 'data', 'lakes.db'),
  ne: process.env.NE_DB_PATH || path.join(__dirname, '..', 'ne-lake-fish', 'data', 'lakes.db'),
  wi: process.env.WI_DB_PATH || path.join(__dirname, '..', 'wi-lake-fish', 'data', 'lakes.db'),
  mi: process.env.MI_DB_PATH || path.join(__dirname, '..', 'mi-lake-fish', 'data', 'lakes.db'),
};

const NE_PDF_DIR = process.env.NE_PDF_DIR ||
  path.join(__dirname, '..', 'ne-lake-fish', 'data', 'pdfs');

const VALID_STATES = new Set(['mn', 'sd', 'nd', 'ia', 'ne', 'wi', 'mi']);

// ── Species code maps for survival model (IA and NE use full English names) ────

const IA_SPECIES_CODE_MAP = {
  'walleye': 'WAE', 'saugeye': 'SAY', 'channel catfish': 'CCF',
  'flathead catfish': 'FHC', 'northern pike': 'NOP', 'muskellunge': 'MUE',
  'tiger muskie': 'TGM', 'largemouth bass': 'LMB', 'smallmouth bass': 'SMB',
  'rainbow trout': 'RBT', 'brown trout': 'BRN', 'brook trout': 'BKT',
  'bluegill': 'BLG', 'yellow perch': 'YEP', 'black crappie': 'BKC',
  'white crappie': 'WHC', 'hybrid striped bass': 'HSB',
};

const MI_SPECIES_CODE_MAP = {
  'walleye': 'WAE', 'sauger': 'SAR', 'saugeye': 'SAU',
  'northern pike': 'NOP', 'muskellunge': 'MUE', 'tiger muskellunge': 'TGM', 'tiger muskie': 'TGM',
  'largemouth bass': 'LMB', 'smallmouth bass': 'SMB',
  'bluegill': 'BLG', 'pumpkinseed': 'PMK', 'black crappie': 'BLC', 'white crappie': 'WHC',
  'yellow perch': 'YEP', 'rock bass': 'RKB',
  'channel catfish': 'CCF', 'flathead catfish': 'FHC',
  'rainbow trout': 'RBT', 'steelhead': 'RBT', 'brown trout': 'BNT', 'brook trout': 'BKT',
  'lake trout': 'LAK', 'lake whitefish': 'LWF', 'lake herring': 'CIS', 'cisco': 'CIS',
  'splake': 'SPL',
  'white bass': 'WHB', 'hybrid striped bass': 'STH', 'wiper': 'STH',
  'lake sturgeon': 'LKS', 'burbot': 'BUR',
};

const NE_SPECIES_CODE_MAP = {
  'walleye': 'WAE', 'saugeye': 'SAY', 'sauger': 'SAR', 'channel catfish': 'CCF',
  'northern pike': 'NOP', 'muskellunge': 'MUE', 'tiger muskie': 'TGM',
  'largemouth bass': 'LMB', 'smallmouth bass': 'SMB', 'rainbow trout': 'RBT',
  'brown trout': 'BRN', 'brook trout': 'BKT', 'bluegill': 'BLG',
  'yellow perch': 'YEP', 'black crappie': 'BLC', 'white crappie': 'WHC',
  'wiper': 'HSB', 'white bass': 'WHB', 'hybrid striped bass': 'HSB',
};

// ── Survival modules (lazy-loaded once per state) ──────────────────────────────

const _survival = {};
function getSurvival(state) {
  if (_survival[state]) return _survival[state];
  try {
    switch (state) {
      case 'mn': _survival[state] = require('../mn-lake-fish/survival'); break;
      case 'sd': _survival[state] = require('../sd-lake-fish/survival'); break;
      case 'nd': _survival[state] = require('../nd-lake-fish/survival'); break;
      case 'ia': _survival[state] = require('../ia-lake-fish/survival'); break;
      case 'ne': _survival[state] = require('../ne-lake-fish/survival'); break;
      case 'wi': _survival[state] = require('../wi-lake-fish/survival'); break;
      case 'mi': _survival[state] = require('../mi-lake-fish/survival'); break;
    }
  } catch (e) {
    console.warn(`[${state}] Could not load survival module: ${e.message}`);
    _survival[state] = { survivingAdults: () => 0, SPECIES_TO_CODE: {} };
  }
  return _survival[state];
}

function resolveSpeciesCode(state, rawSpecies) {
  if (!rawSpecies) return null;
  if (state === 'ia') return IA_SPECIES_CODE_MAP[rawSpecies.toLowerCase()] ?? null;
  if (state === 'ne') return NE_SPECIES_CODE_MAP[rawSpecies.toLowerCase()] ?? null;
  if (state === 'mi') return MI_SPECIES_CODE_MAP[rawSpecies.toLowerCase()] ?? null;
  if (state === 'sd') {
    const { SPECIES_TO_CODE } = getSurvival('sd');
    return (SPECIES_TO_CODE && SPECIES_TO_CODE[rawSpecies]) || rawSpecies;
  }
  return rawSpecies; // mn, nd, wi: stocking.species already holds the code
}

// Compute current and per-year stocking metrics for one lake on the fly.
// Used by /lake/:id so the headline (current adults_per_100ac) and chart
// (per-year line) always come from the same survival.js — no precomputed table.
function computeLakeStockingMetrics(state, areaAcres, stockingRows) {
  if (!areaAcres || areaAcres <= 0 || !stockingRows?.length) {
    return { metrics: [], metrics_by_year: [] };
  }
  const { survivingAdults } = getSurvival(state);
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

  for (let y = firstYear; y <= currentYear; y++) {
    const asOf = new Date(today.getTime());
    if (y !== currentYear) asOf.setFullYear(y);
    for (const r of recent) {
      if (r.stock_year > y) continue;
      const adults = survivingAdults(r._code, r.life_stage, r.stock_year, r.quantity, asOf);
      if (adults <= 0) continue;
      const k = `${r.species}|${y}`;
      byKey.set(k, (byKey.get(k) || 0) + adults);
    }
  }

  const metrics_by_year = [];
  const currentBySpecies = new Map();
  for (const [k, totalAdults] of byKey) {
    const [species, yrStr] = k.split('|');
    const year = Number(yrStr);
    const val = Math.round((totalAdults / acres100) * 10) / 10;
    if (val <= 0) continue;
    metrics_by_year.push({ species, year, adults_per_100ac: val });
    if (year === currentYear) currentBySpecies.set(species, val);
  }
  metrics_by_year.sort((a, b) =>
    a.species === b.species ? a.year - b.year : a.species.localeCompare(b.species));

  const metrics = [...currentBySpecies.entries()]
    .map(([species, adults_per_100ac]) => ({ species, adults_per_100ac }))
    .sort((a, b) => b.adults_per_100ac - a.adults_per_100ac);

  return { metrics, metrics_by_year };
}

// ── SD: run schema migrations on the SD database ──────────────────────────────

function migrateSd(db) {
  const catchCols = new Set(db.prepare('PRAGMA table_info(fish_catch)').all().map(c => c.name));
  for (const col of ['wr_sq', 'wr_qp', 'wr_pm', 'wr_m', 'n_sq', 'n_qp', 'n_pm', 'n_m']) {
    if (!catchCols.has(col)) db.exec(`ALTER TABLE fish_catch ADD COLUMN ${col} INTEGER`);
  }
  const lakeCols = new Set(db.prepare('PRAGMA table_info(lakes)').all().map(c => c.name));
  if (!lakeCols.has('max_depth_feet')) db.exec(`ALTER TABLE lakes ADD COLUMN max_depth_feet REAL`);
  const surveyCols = new Set(db.prepare('PRAGMA table_info(surveys)').all().map(c => c.name));
  if (!surveyCols.has('report_id')) {
    db.exec(`ALTER TABLE surveys ADD COLUMN report_id INTEGER`);
    db.exec(`UPDATE surveys SET report_id = id WHERE report_id IS NULL`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS stocking (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lake_id INTEGER NOT NULL,
      survey_id INTEGER NOT NULL, stock_year INTEGER NOT NULL,
      species TEXT NOT NULL, life_stage TEXT, quantity INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lake_stocking_metrics (
      lake_id INTEGER NOT NULL, species TEXT NOT NULL, adults_per_100ac REAL NOT NULL,
      PRIMARY KEY (lake_id, species)
    );
    CREATE INDEX IF NOT EXISTS idx_stocking_lake ON stocking(lake_id);
  `);
}

function computeSdStockingMetrics(db) {
  const { survivingAdults, SPECIES_TO_CODE } = getSurvival('sd');
  const rows = db.prepare(`
    SELECT s.lake_id, l.area_acres, s.species, s.life_stage, s.stock_year, s.quantity
    FROM stocking s JOIN lakes l ON l.id = s.lake_id
    WHERE l.area_acres > 0 AND s.stock_year >= ?
  `).all(STOCKING_CUTOFF_YEAR);

  const map = new Map();
  for (const r of rows) {
    const code = (SPECIES_TO_CODE && SPECIES_TO_CODE[r.species]) || r.species;
    const adults = survivingAdults(code, r.life_stage, r.stock_year, r.quantity, new Date());
    if (adults <= 0) continue;
    const key = `${r.lake_id}:${r.species}`;
    if (!map.has(key)) map.set(key, { lake_id: r.lake_id, species: r.species, area_acres: r.area_acres, total: 0 });
    map.get(key).total += adults;
  }
  const upsert = db.prepare(`INSERT OR REPLACE INTO lake_stocking_metrics (lake_id, species, adults_per_100ac) VALUES (?,?,?)`);
  db.transaction(() => {
    for (const v of map.values())
      upsert.run(v.lake_id, v.species, Math.round(v.total / (v.area_acres / 100) * 10) / 10);
  })();
  console.log(`[sd] Stocking metrics written for ${map.size} (lake, species) pairs`);
}

// ── Database connections (one per state, lazy with SD migration) ───────────────

const _dbs = {};
function getDb(state) {
  if (_dbs[state]) return _dbs[state];
  const dbPath = STATE_DB_PATHS[state];
  if (!fs.existsSync(dbPath)) return null;

  if (state === 'sd') {
    const rw = new Database(dbPath);
    rw.pragma('journal_mode = WAL');
    migrateSd(rw);
    computeSdStockingMetrics(rw);
    rw.close();
  }

  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  _dbs[state] = db;
  return db;
}

// ── In-memory stocking metrics (ND, IA, NE) ────────────────────────────────────

const _stockingMetrics = {};
function getInMemoryStockingMetrics(state) {
  if (_stockingMetrics[state]) return _stockingMetrics[state];
  const db = getDb(state);
  if (!db) return (_stockingMetrics[state] = new Map());

  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stocking'").get();
  if (!hasTable) return (_stockingMetrics[state] = new Map());

  const codeMap = state === 'ia' ? IA_SPECIES_CODE_MAP : state === 'ne' ? NE_SPECIES_CODE_MAP : state === 'mi' ? MI_SPECIES_CODE_MAP : null;
  const { survivingAdults } = getSurvival(state);
  const rows = db.prepare(`
    SELECT s.lake_id, s.species, s.life_stage, s.stock_year, s.quantity, l.area_acres
    FROM stocking s JOIN lakes l ON l.id = s.lake_id
    WHERE s.stock_year >= ? AND l.area_acres > 0
  `).all(STOCKING_CUTOFF_YEAR);

  const metrics = new Map();
  for (const row of rows) {
    const code = codeMap ? (codeMap[row.species.toLowerCase()] ?? null) : row.species;
    if (!code) continue;
    const adults = survivingAdults(code, row.life_stage, row.stock_year, row.quantity, new Date());
    if (adults <= 0) continue;
    if (!metrics.has(row.lake_id)) metrics.set(row.lake_id, new Map());
    const lakeMap = metrics.get(row.lake_id);
    lakeMap.set(row.species, (lakeMap.get(row.species) || 0) + adults / (row.area_acres / 100));
  }
  for (const speciesMap of metrics.values())
    for (const [sp, v] of speciesMap) speciesMap.set(sp, Math.round(v * 10) / 10);

  _stockingMetrics[state] = metrics;
  console.log(`[${state}] In-memory stocking metrics for ${metrics.size} lakes`);
  return metrics;
}

// Attach stocked_per_100ac from in-memory metrics to result rows
function attachStockingMetrics(rows, state) {
  const metrics = getInMemoryStockingMetrics(state);
  return rows.map(row => {
    const lakeMap = metrics.get(row.lake_id) ?? metrics.get(String(row.lake_id)) ?? metrics.get(Number(row.lake_id));
    return { ...row, stocked_per_100ac: lakeMap?.get(row.species) ?? null };
  });
}

// ── Route guard ───────────────────────────────────────────────────────────────

function validateState(req, res) {
  if (!VALID_STATES.has(req.params.state)) {
    res.status(400).json({ error: `Unknown state: ${req.params.state}` });
    return false;
  }
  return true;
}

// ── /api/:state/status ─────────────────────────────────────────────────────────

app.get('/api/:state/status', (req, res) => {
  if (!validateState(req, res)) return;
  const { state } = req.params;
  const db = getDb(state);
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
  const { state } = req.params;
  const db = getDb(state);
  if (!db) return res.status(503).json({ error: 'Database not ready' });

  try {
    const hasCatch = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fish_catch'").get();

    const species = hasCatch ? db.prepare(`
      SELECT fc.species, COUNT(DISTINCT fc.lake_id) as lake_count
      FROM fish_catch fc GROUP BY fc.species ORDER BY lake_count DESC
    `).all() : [];

    const counties = db.prepare(`
      SELECT DISTINCT county FROM lakes WHERE county IS NOT NULL ORDER BY county
    `).all().map(r => r.county);

    const yearRange = hasCatch
      ? db.prepare('SELECT MIN(survey_year) as min, MAX(survey_year) as max FROM surveys').get()
      : { min: null, max: null };

    // Iowa: derive gear types from station presence columns
    let gearTypes = [];
    let gearTypeCounts = undefined;
    let defaultGear = undefined;
    if (state === 'ia' && hasCatch) {
      const row = db.prepare(`
        SELECT
          MAX(CASE WHEN s.ef_stations > 0 THEN 1 ELSE 0 END) as has_ef,
          MAX(CASE WHEN s.fn_stations > 0 THEN 1 ELSE 0 END) as has_fn,
          MAX(CASE WHEN s.hn_stations > 0 THEN 1 ELSE 0 END) as has_hn
        FROM surveys s JOIN fish_catch fc ON fc.survey_id = s.id
      `).get();
      if (row.has_ef) gearTypes.push('EF');
      if (row.has_fn) gearTypes.push('FN');
      if (row.has_hn) gearTypes.push('HN');
      // Which passive gear is more common?
      const prow = db.prepare(`
        SELECT SUM(CASE WHEN fn_stations > 0 THEN 1 ELSE 0 END) AS fn_count,
               SUM(CASE WHEN hn_stations > 0 THEN 1 ELSE 0 END) AS hn_count
        FROM surveys
      `).get();
      if (prow && (prow.fn_count || prow.hn_count)) {
        defaultGear = prow.fn_count >= prow.hn_count ? 'FN' : 'HN';
        gearTypeCounts = {};
        if (row.has_ef) gearTypeCounts['EF'] = db.prepare(`SELECT SUM(CASE WHEN ef_stations > 0 THEN 1 ELSE 0 END) as n FROM surveys`).get().n || 0;
        if (row.has_fn) gearTypeCounts['FN'] = prow.fn_count || 0;
        if (row.has_hn) gearTypeCounts['HN'] = prow.hn_count || 0;
      }
    } else if (state === 'mi' && hasCatch) {
      const gearRows = db.prepare(`
        SELECT gear, COUNT(*) as n FROM surveys
        WHERE gear IS NOT NULL GROUP BY gear ORDER BY n DESC
      `).all();
      gearTypes = gearRows.map(r => r.gear);
      gearTypeCounts = Object.fromEntries(gearRows.map(r => [r.gear, r.n]));
    } else if (hasCatch) {
      const gearRows = db.prepare(`
        SELECT gear, COUNT(*) as n FROM fish_catch
        WHERE gear IS NOT NULL GROUP BY gear ORDER BY n DESC
      `).all();
      gearTypes = gearRows.map(r => r.gear);
      gearTypeCounts = Object.fromEntries(gearRows.map(r => [r.gear, r.n]));
    }

    const result = { species, gearTypes, gearTypeCounts, counties, yearRange };
    if (defaultGear !== undefined) result.defaultGear = defaultGear;

    // MN: include survey types
    if (state === 'mn') {
      result.surveyTypes = db.prepare(`
        SELECT DISTINCT survey_type FROM surveys WHERE survey_type IS NOT NULL ORDER BY survey_type
      `).all().map(r => r.survey_type);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/:state/results ────────────────────────────────────────────────────────

app.get('/api/:state/results', (req, res) => {
  if (!validateState(req, res)) return;
  const { state } = req.params;
  const db = getDb(state);
  if (!db) return res.status(503).json({ error: 'Database not ready' });

  const hasCatch = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fish_catch'").get();
  if (!hasCatch) return res.json({ total: 0, results: [] });

  try {
    const {
      species, lakeName, gear,
      minCpue, maxCpue,
      minYear, maxYear,
      county, minAcres, maxAcres,
      minStocked, maxStocked,
      mostRecentOnly,
      // MN-only
      surveyType, cpueVsNormal,
      minWeight, maxWeight,
      minCatch, maxCatch,
      minGearCount, maxGearCount,
      sortBy = 'cpue',
      sortDir = 'desc',
      limit = '100',
      offset = '0',
    } = req.query;

    // Validate and clamp numeric query params
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    const conditions = [];
    const params = [];

    if (species)       { conditions.push('fc.species = ?'); params.push(species); }
    if (lakeName?.trim()) { conditions.push('LOWER(l.name) LIKE LOWER(?)'); params.push(`%${lakeName.trim()}%`); }

    // Gear filter — IA uses station-presence columns, others use fc.gear
    if (gear) {
      const gears = gear.split(',').filter(Boolean);
      if (state === 'ia') {
        const conds = gears.map(g => {
          if (g === 'EF') return 's.ef_stations > 0';
          if (g === 'FN') return 's.fn_stations > 0';
          if (g === 'HN') return 's.hn_stations > 0';
          return null;
        }).filter(Boolean);
        if (conds.length) conditions.push(`(${conds.join(' OR ')})`);
      } else if (state === 'mi' && gears.length) {
        conditions.push(`fc.gear IN (${gears.map(() => '?').join(',')})`);
        params.push(...gears);
      } else if (gears.length) {
        conditions.push(`fc.gear IN (${gears.map(() => '?').join(',')})`);
        params.push(...gears);
      }
    }

    if (minCpue !== undefined && minCpue !== '') { conditions.push('fc.cpue >= ?'); params.push(parseFloat(minCpue)); }
    if (maxCpue !== undefined && maxCpue !== '') { conditions.push('fc.cpue <= ?'); params.push(parseFloat(maxCpue)); }
    if (minYear !== undefined && minYear !== '') { conditions.push('s.survey_year >= ?'); params.push(parseInt(minYear, 10)); }
    if (maxYear !== undefined && maxYear !== '') { conditions.push('s.survey_year <= ?'); params.push(parseInt(maxYear, 10)); }

    if (county) {
      const counties = county.split(',').filter(Boolean);
      if (counties.length) {
        conditions.push(`l.county IN (${counties.map(() => '?').join(',')})`);
        params.push(...counties);
      }
    }
    if (minAcres !== undefined && minAcres !== '') { conditions.push('l.area_acres >= ?'); params.push(parseFloat(minAcres)); }
    if (maxAcres !== undefined && maxAcres !== '') { conditions.push('l.area_acres <= ?'); params.push(parseFloat(maxAcres)); }

    // MN-specific filters
    if (state === 'mn') {
      if (surveyType) {
        const types = surveyType.split(',').filter(Boolean);
        if (types.length) { conditions.push(`s.survey_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
      }
      if (minWeight !== undefined && minWeight !== '') { conditions.push('fc.average_weight >= ?'); params.push(parseFloat(minWeight)); }
      if (maxWeight !== undefined && maxWeight !== '') { conditions.push('fc.average_weight <= ?'); params.push(parseFloat(maxWeight)); }
      if (minCatch  !== undefined && minCatch  !== '') { conditions.push('fc.total_catch >= ?');    params.push(parseInt(minCatch, 10)); }
      if (maxCatch  !== undefined && maxCatch  !== '') { conditions.push('fc.total_catch <= ?');    params.push(parseInt(maxCatch, 10)); }
      if (minGearCount !== undefined && minGearCount !== '') { conditions.push('fc.gear_count >= ?'); params.push(parseInt(minGearCount, 10)); }
      if (maxGearCount !== undefined && maxGearCount !== '') { conditions.push('fc.gear_count <= ?'); params.push(parseInt(maxGearCount, 10)); }
      if (cpueVsNormal === 'above') {
        conditions.push('fc.quartile_count_high IS NOT NULL AND fc.cpue > fc.quartile_count_high');
      } else if (cpueVsNormal === 'below') {
        conditions.push('fc.quartile_count_low IS NOT NULL AND fc.cpue < fc.quartile_count_low');
      } else if (cpueVsNormal === 'within') {
        conditions.push('fc.cpue IS NOT NULL AND fc.quartile_count_low IS NOT NULL AND fc.quartile_count_high IS NOT NULL');
        conditions.push('fc.cpue >= fc.quartile_count_low AND fc.cpue <= fc.quartile_count_high');
      }
    }

    // ── mostRecentOnly CTE (state-specific date expression) ──────────────────
    let ctePrefix = '';
    const cteParams = [];
    let mostRecentJoin = '';

    if (mostRecentOnly === 'true') {
      const subConds = [];
      if (species) { subConds.push('fc2.species = ?'); cteParams.push(species); }

      if (gear) {
        const gears = gear.split(',').filter(Boolean);
        if (state === 'ia') {
          const gconds = gears.map(g =>
            g === 'EF' ? 's2.ef_stations > 0' :
            g === 'FN' ? 's2.fn_stations > 0' :
            g === 'HN' ? 's2.hn_stations > 0' : null
          ).filter(Boolean);
          if (gconds.length) subConds.push(`(${gconds.join(' OR ')})`);
        } else if (gears.length) {
          subConds.push(`fc2.gear IN (${gears.map(() => '?').join(',')})`);
          cteParams.push(...gears);
        }
      }

      // IA: exclude consolidated rollup rows from most-recent calculation
      if (state === 'ia') subConds.push('s2.survey_date IS NOT NULL');

      const subWhere = subConds.length ? 'WHERE ' + subConds.join(' AND ') : '';

      if (state === 'mn') {
        // MN surveys have reliable survey_date
        ctePrefix = `WITH _most_recent AS (
          SELECT s2.lake_id, MAX(s2.survey_date) AS max_date
          FROM surveys s2 JOIN fish_catch fc2 ON fc2.survey_id = s2.id ${subWhere}
          GROUP BY s2.lake_id
        )`;
        mostRecentJoin = 'JOIN _most_recent mr ON mr.lake_id = l.id AND s.survey_date = mr.max_date';
      } else if (state === 'ia') {
        // IA: s2.survey_date IS NOT NULL already added to subConds above
        ctePrefix = `WITH _most_recent AS (
          SELECT s2.lake_id, MAX(s2.survey_date) AS max_date
          FROM surveys s2 JOIN fish_catch fc2 ON fc2.survey_id = s2.id ${subWhere}
          GROUP BY s2.lake_id
        )`;
        mostRecentJoin = `JOIN _most_recent mr ON mr.lake_id = l.id AND s.survey_date = mr.max_date`;
      } else {
        // SD, ND, NE: use survey_year
        ctePrefix = `WITH _most_recent AS (
          SELECT s2.lake_id, MAX(s2.survey_year) AS max_year
          FROM surveys s2 JOIN fish_catch fc2 ON fc2.survey_id = s2.id ${subWhere}
          GROUP BY s2.lake_id
        )`;
        mostRecentJoin = 'JOIN _most_recent mr ON mr.lake_id = l.id AND s.survey_year = mr.max_year';
      }
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // ── State-specific SELECT columns and JOINs ───────────────────────────────

    let selectCols, extraJoins;

    if (state === 'mn') {
      selectCols = `
        l.id AS lake_id, l.name AS lake_name, l.county, l.area_acres, l.max_depth_feet,
        l.latitude, l.longitude,
        s.id AS survey_id, s.survey_date, s.survey_year, s.survey_type, s.survey_sub_type,
        fc.species, fc.gear, fc.gear_count, fc.total_catch, fc.average_weight, fc.cpue,
        fc.quartile_count_low, fc.quartile_count_high,
        lsm.adults_per_100ac AS stocked_per_100ac`;
      extraJoins = 'LEFT JOIN lake_stocking_metrics lsm ON lsm.lake_id = fc.lake_id AND lsm.species = fc.species';
    } else if (state === 'sd') {
      selectCols = `
        l.id AS lake_id, l.name AS lake_name, l.county, l.area_acres, l.max_depth_feet,
        s.id AS survey_id, s.survey_year, s.report_id,
        fc.species, fc.gear, fc.sample_n, fc.cpue, fc.cpue_ci,
        fc.psd, fc.psd_p, fc.wr, fc.wr_sq, fc.wr_qp, fc.wr_pm, fc.wr_m,
        fc.n_sq, fc.n_qp, fc.n_pm, fc.n_m,
        lsm.adults_per_100ac AS stocked_per_100ac`;
      extraJoins = 'LEFT JOIN lake_stocking_metrics lsm ON lsm.lake_id = fc.lake_id AND lsm.species = fc.species';
    } else if (state === 'nd') {
      selectCols = `
        l.id AS lake_id, l.name AS lake_name, l.county, l.area_acres,
        s.id AS survey_id, s.survey_year, s.survey_date,
        fc.species, fc.species_name, fc.gear, fc.total_catch, fc.cpue, fc.average_length`;
      extraJoins = '';
    } else if (state === 'ia') {
      // IA has optional ia_size_classes table for average_length fallback.
      // Only apply the fallback on consolidated rows (survey_date IS NULL) —
      // per-date rows don't have their own average length and showing the
      // lifetime estimate on every date would be misleading.
      const hasSizeClasses = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ia_size_classes'").get();
      const avgLen = hasSizeClasses
        ? 'CASE WHEN s.survey_date IS NULL THEN COALESCE(fc.average_length, sc.avg_length_est) ELSE fc.average_length END'
        : 'fc.average_length';
      const hasLSM = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lake_stocking_metrics'").get();
      selectCols = `
        l.id AS lake_id, l.name AS lake_name, l.county, l.area_acres,
        s.id AS survey_id, s.survey_year, s.survey_date, s.gear AS survey_gear,
        fc.species, fc.gear, fc.total_catch, fc.cpue,
        ${avgLen} AS average_length,
        fc.n_measured, fc.min_length, fc.max_length,
        CASE WHEN s.gear = 'EF' THEN fc.cpue ELSE NULL END AS ef_cpue, s.ef_stations,
        CASE WHEN s.gear = 'HN' THEN fc.cpue ELSE NULL END AS hn_cpue, s.hn_stations,
        CASE WHEN s.gear = 'FN' THEN fc.cpue ELSE NULL END AS fn_cpue, s.fn_stations,
        ${hasLSM ? 'lsm.adults_per_100ac' : 'NULL'} AS stocked_per_100ac`;
      extraJoins = [
        hasSizeClasses ? 'LEFT JOIN ia_size_classes sc ON sc.species = fc.species AND sc.lake_name = l.name' : '',
        hasLSM ? 'LEFT JOIN lake_stocking_metrics lsm ON lsm.lake_id = fc.lake_id AND lsm.species = fc.species' : '',
      ].filter(Boolean).join('\n');
    } else if (state === 'wi') {
      selectCols = `
        l.id AS lake_id, l.name AS lake_name, l.county, l.area_acres,
        s.id AS survey_id, s.survey_year, s.survey_date,
        fc.species, fc.species_name, fc.gear, fc.total_catch, fc.cpue, fc.average_length`;
      extraJoins = '';
    } else if (state === 'mi') {
      selectCols = `
        l.id AS lake_id, l.name AS lake_name, l.county, l.area_acres, l.max_depth_feet,
        l.latitude, l.longitude,
        s.id AS survey_id, s.survey_year,
        fc.species, fc.gear, fc.total_catch, fc.cpue, fc.avg_length, fc.weight_lbs`;
      extraJoins = '';
    } else { // ne
      selectCols = `
        l.id AS lake_id, l.name AS lake_name, l.county, l.area_acres,
        s.id AS survey_id, s.survey_year, s.survey_date,
        fc.species, fc.gear, fc.cpue, fc.average_length`;
      extraJoins = '';
    }

    // ── Sort column map ───────────────────────────────────────────────────────

    const SORT_COLS = {
      cpue: state === 'mi' ? 'COALESCE(fc.cpue, 0)' : 'fc.cpue',
      lake: 'l.name', acres: 'l.area_acres', year: 's.survey_year',
      // ND/NE/WI/MI compute stocked_per_100ac in JS after the query — sorting by it in SQL isn't
      // possible there, so fall back to fc.cpue (NE has no fc.total_catch column at all).
      stocked: ['mn', 'sd', 'ia'].includes(state) ? 'lsm.adults_per_100ac' : 'fc.cpue',
      // MN
      weight: 'fc.average_weight', catch: 'fc.total_catch',
      date: state === 'ia' ? "COALESCE(s.survey_date, CAST(s.survey_year AS TEXT) || '-12-31')" : 's.survey_date',
      depth: 'l.max_depth_feet',
      // ND, IA, NE
      length: state === 'ia'
        ? ((() => { try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ia_size_classes'").get(); } catch { return false; } })()
           ? 'CASE WHEN s.survey_date IS NULL THEN COALESCE(fc.average_length, sc.avg_length_est) ELSE fc.average_length END' : 'fc.average_length')
        : 'fc.average_length',
      // SD
      psd: 'fc.psd', psd_p: 'fc.psd_p', wr: 'fc.wr',
      wr_sq: 'fc.wr_sq', wr_qp: 'fc.wr_qp', wr_pm: 'fc.wr_pm', wr_m: 'fc.wr_m',
      // IA gear-specific
      ef_cpue: "CASE WHEN s.gear = 'EF' THEN fc.cpue ELSE NULL END",
      hn_cpue: "CASE WHEN s.gear = 'HN' THEN fc.cpue ELSE NULL END",
      fn_cpue: "CASE WHEN s.gear = 'FN' THEN fc.cpue ELSE NULL END",
    };
    const sortCol = SORT_COLS[sortBy] ?? 'fc.cpue';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

    const joinsSql = `
      FROM fish_catch fc
      JOIN surveys s ON fc.survey_id = s.id
      JOIN lakes l ON fc.lake_id = l.id
      ${extraJoins}
      ${mostRecentJoin}
      ${whereClause}
    `;

    const allParams = [...cteParams, ...params];
    const total = db.prepare(`${ctePrefix} SELECT COUNT(*) as n ${joinsSql}`).get(allParams).n;

    let rows = db.prepare(`
      ${ctePrefix}
      SELECT ${selectCols} ${joinsSql}
      ORDER BY ${sortCol} ${dir} NULLS LAST
      LIMIT ? OFFSET ?
    `).all([...allParams, limitNum, offsetNum]);

    // ND, NE, WI, MI: attach stocked_per_100ac from in-memory metrics
    if (state === 'nd' || state === 'ne' || state === 'wi' || state === 'mi') {
      rows = attachStockingMetrics(rows, state);
    }

    // SD: handle stocked filter post-query (stocked_per_100ac comes from SQL JOIN)
    if (minStocked !== undefined && minStocked !== '') {
      rows = rows.filter(r => r.stocked_per_100ac != null && r.stocked_per_100ac >= parseFloat(minStocked));
    }
    if (maxStocked !== undefined && maxStocked !== '') {
      rows = rows.filter(r => r.stocked_per_100ac != null && r.stocked_per_100ac <= parseFloat(maxStocked));
    }

    res.json({ total, results: rows });
  } catch (err) {
    console.error(`[${req.params.state}] /results error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/:state/lake/:id ───────────────────────────────────────────────────────

app.get('/api/:state/lake/:id', (req, res) => {
  if (!validateState(req, res)) return;
  const { state, id } = req.params;
  if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: 'Invalid lake id' });
  const db = getDb(state);
  if (!db) return res.status(503).json({ error: 'Database not ready' });

  try {
    const lake = db.prepare('SELECT * FROM lakes WHERE id = ?').get(id);
    if (!lake) return res.status(404).json({ error: 'Lake not found' });

    const hasCatch = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fish_catch'").get();

    // ── Surveys ──────────────────────────────────────────────────────────────
    let surveys = [];
    if (state === 'mn') {
      surveys = db.prepare(`
        SELECT s.id, s.survey_date, s.survey_year, s.survey_type, s.survey_sub_type,
               COUNT(fc.id) as species_count, GROUP_CONCAT(DISTINCT fc.species) as species_list
        FROM surveys s LEFT JOIN fish_catch fc ON fc.survey_id = s.id
        WHERE s.lake_id = ? GROUP BY s.id ORDER BY s.survey_date DESC
      `).all(id);
    } else if (state === 'sd') {
      surveys = db.prepare(`
        SELECT s.id, s.survey_year, s.report_id,
               COUNT(fc.id) as species_count, GROUP_CONCAT(DISTINCT fc.species) as species_list
        FROM surveys s LEFT JOIN fish_catch fc ON fc.survey_id = s.id
        WHERE s.lake_id = ? GROUP BY s.id ORDER BY s.survey_year DESC
      `).all(id);
    } else if (state === 'ne') {
      surveys = hasCatch ? db.prepare(`
        SELECT s.id, s.survey_year, s.survey_date, s.gear, s.source_pdf,
               COUNT(fc.id) as species_count, GROUP_CONCAT(DISTINCT fc.species) as species_list
        FROM surveys s LEFT JOIN fish_catch fc ON fc.survey_id = s.id
        WHERE s.lake_id = ? GROUP BY s.id ORDER BY s.survey_year DESC
      `).all(id) : [];
    } else if (state === 'mi') {
      surveys = hasCatch ? db.prepare(`
        SELECT s.id, s.survey_year, s.gear,
               COUNT(fc.id) as species_count, GROUP_CONCAT(DISTINCT fc.species) as species_list
        FROM surveys s LEFT JOIN fish_catch fc ON fc.survey_id = s.id
        WHERE s.lake_id = ? GROUP BY s.id ORDER BY s.survey_year DESC
      `).all(id) : [];
    } else {
      surveys = hasCatch ? db.prepare(`
        SELECT s.id, s.survey_year, s.survey_date, s.gear,
               COUNT(fc.id) as species_count, GROUP_CONCAT(DISTINCT fc.species) as species_list
        FROM surveys s LEFT JOIN fish_catch fc ON fc.survey_id = s.id
        WHERE s.lake_id = ? GROUP BY s.id ORDER BY s.survey_year DESC
      `).all(id) : [];
    }

    // ── Catches ───────────────────────────────────────────────────────────────
    let catches = [];
    if (state === 'mn' && hasCatch) {
      catches = db.prepare(`
        SELECT fc.species, fc.gear, fc.survey_id, s.survey_date, s.survey_year, s.survey_type,
               fc.cpue, fc.average_weight, fc.total_catch, fc.gear_count,
               fc.quartile_count_low, fc.quartile_count_high
        FROM fish_catch fc JOIN surveys s ON s.id = fc.survey_id
        WHERE fc.lake_id = ? ORDER BY s.survey_date DESC, fc.species
      `).all(id);
    } else if (state === 'sd' && hasCatch) {
      catches = db.prepare(`
        SELECT fc.species, fc.gear, fc.survey_id, s.survey_year, s.report_id,
               fc.cpue, fc.cpue_ci, fc.sample_n, fc.psd, fc.psd_p, fc.wr,
               fc.wr_sq, fc.wr_qp, fc.wr_pm, fc.wr_m, fc.n_sq, fc.n_qp, fc.n_pm, fc.n_m
        FROM fish_catch fc JOIN surveys s ON s.id = fc.survey_id
        WHERE fc.lake_id = ? ORDER BY s.survey_year DESC, fc.species
      `).all(id);
    } else if (state === 'nd' && hasCatch) {
      catches = db.prepare(`
        SELECT fc.species, fc.species_name, fc.gear, fc.survey_id,
               s.survey_year, s.survey_date, fc.cpue, fc.total_catch, fc.average_length
        FROM fish_catch fc JOIN surveys s ON s.id = fc.survey_id
        WHERE fc.lake_id = ? ORDER BY s.survey_year DESC, fc.species
      `).all(id);
    } else if (state === 'ia' && hasCatch) {
      const hasSC = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ia_size_classes'").get();
      const avgLen = hasSC ? 'CASE WHEN s.survey_date IS NULL THEN COALESCE(fc.average_length, sc.avg_length_est) ELSE fc.average_length END' : 'fc.average_length';
      const scJoin = hasSC ? 'LEFT JOIN ia_size_classes sc ON sc.species = fc.species AND sc.lake_name = l.name' : '';
      catches = db.prepare(`
        SELECT fc.species, fc.gear, fc.survey_id, s.survey_year, s.survey_date, s.gear AS survey_gear,
               fc.cpue, fc.total_catch, ${avgLen} AS average_length,
               fc.n_measured, fc.min_length, fc.max_length,
               CASE WHEN s.gear = 'EF' THEN fc.cpue ELSE NULL END AS ef_cpue, s.ef_stations,
               CASE WHEN s.gear = 'HN' THEN fc.cpue ELSE NULL END AS hn_cpue, s.hn_stations,
               CASE WHEN s.gear = 'FN' THEN fc.cpue ELSE NULL END AS fn_cpue, s.fn_stations
        FROM fish_catch fc JOIN surveys s ON s.id = fc.survey_id
        JOIN lakes l ON l.id = fc.lake_id
        ${scJoin}
        WHERE fc.lake_id = ?
        ORDER BY COALESCE(s.survey_date, CAST(s.survey_year AS TEXT) || '-12-31') DESC, fc.species
      `).all(id);
    } else if (state === 'ne' && hasCatch) {
      catches = db.prepare(`
        SELECT fc.species, fc.gear, fc.survey_id, s.survey_year, s.survey_date,
               fc.cpue, fc.average_length
        FROM fish_catch fc JOIN surveys s ON s.id = fc.survey_id
        WHERE fc.lake_id = ? ORDER BY s.survey_year DESC, fc.species
      `).all(id);
    } else if (state === 'wi' && hasCatch) {
      catches = db.prepare(`
        SELECT fc.species, fc.species_name, fc.gear, fc.survey_id,
               s.survey_year, s.survey_date, fc.cpue, fc.total_catch, fc.average_length
        FROM fish_catch fc JOIN surveys s ON s.id = fc.survey_id
        WHERE fc.lake_id = ? ORDER BY s.survey_year DESC, fc.species
      `).all(id);
    } else if (state === 'mi' && hasCatch) {
      catches = db.prepare(`
        SELECT fc.species, fc.gear, fc.survey_id, s.survey_year,
               fc.total_catch, fc.cpue, fc.cpue_all_gear, fc.cpue_normalized,
               fc.avg_length, fc.weight_lbs
        FROM fish_catch fc JOIN surveys s ON s.id = fc.survey_id
        WHERE fc.lake_id = ? ORDER BY s.survey_year DESC, fc.species
      `).all(id);
    }

    // ── Stocking ──────────────────────────────────────────────────────────────
    let stocking = [];
    try {
      stocking = db.prepare(`
        SELECT stock_year, species, life_stage, SUM(quantity) as quantity
        FROM stocking WHERE lake_id = ?
        GROUP BY stock_year, species, life_stage ORDER BY stock_year DESC, species
      `).all(id);
    } catch { /* stocking table may not exist */ }

    // ── Stocking metrics (computed on the fly so headline matches per-year chart) ─
    const { metrics, metrics_by_year } = computeLakeStockingMetrics(state, lake.area_acres, stocking);

    res.json({ lake, surveys, catches, stocking, metrics, metrics_by_year });
  } catch (err) {
    console.error(`[${state}] /lake/${id} error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/:state/reload ────────────────────────────────────────────────────────
// Drops and reopens the DB connection for one state so fresh data is served
// immediately after a scrape run — no server restart needed.
// Safe to call in production (rate-limited, read-only data, single-threaded).

app.post('/api/:state/reload', requireReloadToken, (req, res) => {
  if (!validateState(req, res)) return;
  const { state } = req.params;

  // Close and evict cached DB connection
  if (_dbs[state]) {
    try { _dbs[state].close(); } catch {}
    delete _dbs[state];
  }

  // Evict cached in-memory stocking metrics
  delete _stockingMetrics[state];

  // Re-open (runs SD migrations + stocking metrics recomputation if needed)
  const db = getDb(state);
  if (!db) return res.status(503).json({ error: `Database not found at ${STATE_DB_PATHS[state]}` });

  // Pre-warm in-memory metrics for non-SD/MN states
  if (!['mn', 'sd'].includes(state)) getInMemoryStockingMetrics(state);

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

// ── Startup ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Lake Fish mobile server running on port ${PORT}`);
  console.log('Routes: /api/{mn|sd|nd|ia|ne|wi|mi}/{status|filters|results|lake/:id}');

  // Pre-warm all available databases and stocking metrics
  for (const state of VALID_STATES) {
    const db = getDb(state);
    if (db) {
      try {
        const n = db.prepare('SELECT COUNT(*) as n FROM lakes').get().n;
        console.log(`  [${state}] ready — ${n} lakes`);
        if (!['mn', 'sd'].includes(state)) getInMemoryStockingMetrics(state);
      } catch (e) {
        console.warn(`  [${state}] startup warning: ${e.message}`);
      }
    } else {
      console.log(`  [${state}] database not found — skipping`);
    }
  }
});
