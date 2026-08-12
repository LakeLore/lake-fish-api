'use strict';

// ── Canonical (registry-driven) route handlers ────────────────────────────────
// Generic handlers serving every active state from the canonical data path
// (lakelore-data/out/{state}.db, schema per lakelore-data/schema/canonical.sql).
// server.js dispatches /filters, /results, and /lake/:id here unconditionally —
// the legacy per-state branches were deleted in the P5 cleanup after all five
// active states were parity-proven canonical.
//
// Wire compatibility is the contract: output field lists come from
// lakelore-data/registry/states.json `wire` entries (copied verbatim from the
// legacy per-state SELECTs) and are enforced by lakelore-data/bin/parity.js.
//
// Each handler receives (req, res, ctx) where ctx is built by server.js:
//   ctx.getDb(state)                    — opens the canonical DB (validated)
//   ctx.isUnhealthy(state)              — schema-mismatch flag
//   ctx.getStateEntry(state)            — registry entry (features, wire)
//   ctx.computeLakeStockingMetrics(...) — server.js shared metrics compute

// ── Preview-mode redaction ─────────────────────────────────────────────────────
// Fields withheld from non-subscribers browsing a paid state. The contract with
// the app (2026-07-15): a preview user sees every METRIC (cpue, lengths,
// stocking, depth, metrics_by_year) but nothing that IDENTIFIES the lake —
// no name, county, acreage, coordinates, location blurb, or links/ids that
// resolve to an agency document naming the lake. Redaction is server-side so
// the data never reaches an unentitled device.
const PREVIEW_REDACT_RESULT = [
  'lake_name', 'county', 'area_acres', 'latitude', 'longitude', 'location',
  // Document ids/links resolve to agency reports that name the lake (SD's
  // results wire carries report_id).
  'report_id', 'source_pdf', 'source_url',
];
// /lake preview is an ALLOWLIST (C9, 2026-07-17): the lake row comes from
// SELECT * — with a redaction blocklist, any future identity-ish column added
// to the lakes table would ship to preview users BY DEFAULT. Only the columns
// below may carry values in preview; everything else present is nulled (keys
// stay present so the response shape is stable). Adding a lakes column now
// requires an explicit decision to expose it here.
const PREVIEW_LAKE_ALLOW = new Set(['id', 'max_depth_feet', 'mean_depth_feet', 'water_clarity', 'last_surveyed']);
function redactPreviewLakeAllowlist(row) {
  for (const k of Object.keys(row)) {
    if (!PREVIEW_LAKE_ALLOW.has(k) && row[k] != null) row[k] = null;
  }
}
const PREVIEW_REDACT_DOC_LINKS = ['report_id', 'source_pdf', 'source_url'];

// Null out the listed fields when present. Only touches keys the row already
// carries — wire projections differ per state, and adding absent keys would
// change the response shape.
function redactPreviewFields(row, fields) {
  for (const f of fields) {
    if (f in row && row[f] != null) row[f] = null;
  }
}

// Preview id obfuscation: many 2026-07 states derive lake/survey ids from the
// lake NAME (tx "aquilla-lake"; fl/ny slugs even embed the county), so raw ids
// on the preview wire would defeat the field redaction above. In preview every
// lake/survey id is replaced by a deterministic keyed hash ("p" + 15 hex) —
// deterministic so React keys stay stable across pages and survey_id
// references stay consistent between /results and /lake payloads. /lake/:id
// resolves hashed ids back through a lazily-built per-state reverse map.
const crypto = require('crypto');
// Key precedence: explicit PREVIEW_ID_SECRET → derived from the server-only
// JWT secret (HMAC, so the JWT key itself is never reused directly) → the dev
// literal. The middle tier matters: without it, production quietly ran on the
// repo-known literal, making preview hashes offline-reversible for the many
// states whose raw ids are name slugs. Deriving from LAKELORE_JWT_SECRET keeps
// the key server-only, identical across both machines, and stable across
// restarts — no separate Fly secret required.
const PREVIEW_ID_SECRET = process.env.PREVIEW_ID_SECRET
  || (process.env.LAKELORE_JWT_SECRET
    ? crypto.createHmac('sha256', process.env.LAKELORE_JWT_SECRET).update('lakelore-preview-ids').digest('hex')
    : 'lakelore-preview-ids-v1');
const PREVIEW_ID_RE = /^p[0-9a-f]{15}$/;
function previewId(state, id) {
  return 'p' + crypto.createHmac('sha256', PREVIEW_ID_SECRET)
    .update(`${state}:${id}`).digest('hex').slice(0, 15);
}
const _previewLakeIdMaps = new Map(); // state -> Map(previewId -> real lake id)
function resolvePreviewLakeId(state, db, pid) {
  let map = _previewLakeIdMaps.get(state);
  if (!map) {
    map = new Map();
    for (const { id } of db.prepare('SELECT id FROM lakes').all()) {
      map.set(previewId(state, String(id)), String(id));
    }
    _previewLakeIdMaps.set(state, map);
  }
  return map.get(pid) || null;
}
// Invalidate the cached reverse map for a state. MUST be called whenever the
// state's DB is swapped without a process restart (POST /reload), or a preview
// user tapping a lake ADDED by the refresh 404s on /lake/:id until restart —
// the exact scenario /reload exists to avoid.
function clearPreviewLakeIdMap(state) {
  _previewLakeIdMaps.delete(state);
}

// Map wire field name -> SQL source expression for /results.
// species maps to species_native (registry speciesWire=native): the exact
// legacy string the shipped app expects.
const RESULTS_SRC = {
  lake_id: 'l.id AS lake_id',
  lake_name: 'l.name AS lake_name',
  county: 'l.county',
  area_acres: 'l.area_acres',
  max_depth_feet: 'l.max_depth_feet',
  latitude: 'l.latitude',
  longitude: 'l.longitude',
  survey_id: 's.id AS survey_id',
  survey_date: 's.survey_date',
  survey_year: 's.survey_year',
  survey_type: 's.survey_type',
  survey_sub_type: 's.survey_sub_type',
  survey_gear: 's.gear AS survey_gear',
  report_id: 's.report_id',
  species: 'fc.species_native AS species',
  species_name: 'fc.species_name',
  gear: 'fc.gear',
  gear_count: 'fc.gear_count',
  total_catch: 'fc.total_catch',
  sample_n: 'fc.sample_n',
  average_weight: 'fc.average_weight',
  weight_lbs: 'fc.weight_lbs',
  cpue: 'fc.cpue',
  cpue_kind: 'fc.cpue_kind',
  cpue_ci: 'fc.cpue_ci',
  average_length: 'fc.average_length',
  // Schema v6 (2026-07-17): how the length was obtained ('measured' vs
  // 'estimate'/'chart'/'psd_midpoint') and whether a presence fact was
  // observed or inferred from stocking — both were DB-only before, so
  // estimates displayed indistinguishably from measured means.
  length_derivation: 'fc.length_derivation',
  presence_basis: 'fc.presence_basis',
  min_length: 'fc.min_length',
  max_length: 'fc.max_length',
  n_measured: 'fc.n_measured',
  quartile_count_low: 'fc.quartile_count_low',
  quartile_count_high: 'fc.quartile_count_high',
  psd: 'fc.psd', psd_p: 'fc.psd_p', wr: 'fc.wr',
  wr_sq: 'fc.wr_sq', wr_qp: 'fc.wr_qp', wr_pm: 'fc.wr_pm', wr_m: 'fc.wr_m',
  n_sq: 'fc.n_sq', n_qp: 'fc.n_qp', n_pm: 'fc.n_pm', n_m: 'fc.n_m',
  ef_stations: 's.ef_stations', hn_stations: 's.hn_stations', fn_stations: 's.fn_stations',
  stocked_per_100ac: 'lsm.adults_per_100ac AS stocked_per_100ac',
  // Absolute estimated surviving adults — the metric for stocked lakes with
  // no usable acreage (stocked_per_100ac NULL there). Schema v3.
  stocked_adults_est: 'lsm.adults_est AS stocked_adults_est',
  // Agency fishing-forecast rating (schema v4) — headline metric for
  // ratings-tier states with no published CPUE (GA/MO/IL/FL/KY/OK).
  rating: 'fc.rating',
  rating_ordinal: 'fc.rating_ordinal',
};

// /lake/:id surveys list (legacy aliases COUNT/GROUP_CONCAT the same way).
const LAKE_SURVEYS_SRC = {
  id: 's.id',
  survey_date: 's.survey_date',
  survey_year: 's.survey_year',
  survey_type: 's.survey_type',
  survey_sub_type: 's.survey_sub_type',
  gear: 's.gear',
  report_id: 's.report_id',
  source_pdf: 's.source_pdf',
  source_url: 's.source_url',
  species_count: 'COUNT(fc.id) as species_count',
  species_list: 'GROUP_CONCAT(DISTINCT fc.species_native) as species_list',
};

// /lake/:id catches list. Note survey_id here reads fc.survey_id (legacy did).
const LAKE_CATCHES_SRC = {
  species: 'fc.species_native AS species',
  species_name: 'fc.species_name',
  gear: 'fc.gear',
  survey_id: 'fc.survey_id',
  survey_date: 's.survey_date',
  survey_year: 's.survey_year',
  survey_type: 's.survey_type',
  survey_gear: 's.gear AS survey_gear',
  report_id: 's.report_id',
  cpue: 'fc.cpue',
  cpue_kind: 'fc.cpue_kind',
  cpue_ci: 'fc.cpue_ci',
  cpue_all_gear: 'fc.cpue_all_gear',
  cpue_normalized: 'fc.cpue_normalized',
  average_weight: 'fc.average_weight',
  weight_lbs: 'fc.weight_lbs',
  total_catch: 'fc.total_catch',
  sample_n: 'fc.sample_n',
  gear_count: 'fc.gear_count',
  average_length: 'fc.average_length',
  // Schema v6 — see RESULTS_SRC note.
  length_derivation: 'fc.length_derivation',
  presence_basis: 'fc.presence_basis',
  min_length: 'fc.min_length',
  max_length: 'fc.max_length',
  n_measured: 'fc.n_measured',
  quartile_count_low: 'fc.quartile_count_low',
  quartile_count_high: 'fc.quartile_count_high',
  psd: 'fc.psd', psd_p: 'fc.psd_p', wr: 'fc.wr',
  wr_sq: 'fc.wr_sq', wr_qp: 'fc.wr_qp', wr_pm: 'fc.wr_pm', wr_m: 'fc.wr_m',
  n_sq: 'fc.n_sq', n_qp: 'fc.n_qp', n_pm: 'fc.n_pm', n_m: 'fc.n_m',
  ef_stations: 's.ef_stations', hn_stations: 's.hn_stations', fn_stations: 's.fn_stations',
  // Agency forecast rating (schema v4) — without these on the /lake wire, the
  // ratings-tier states' HEADLINE metric appears in /results but vanishes on
  // the detail screen (IMPROVEMENT_PLAN_2026-07-17 A5).
  rating: 'fc.rating',
  rating_ordinal: 'fc.rating_ordinal',
};

// ORDER BY column tokens used in wire.lakeSurveysOrder / wire.lakeCatchesOrder.
// survey_date_coalesced is IA's legacy /lake catches ordering: consolidated
// rollup surveys (survey_date IS NULL) sort as Dec 31 of their survey year.
const ORDER_SRC = {
  survey_date: 's.survey_date',
  survey_year: 's.survey_year',
  species: 'fc.species_native',
  report_id: 's.report_id',
  survey_date_coalesced: "COALESCE(s.survey_date, CAST(s.survey_year AS TEXT) || '-12-31')",
};

// gearFilterMode='stations' (IA): gear chips map to station-presence columns
// on the surveys table. Keyed by chip token; value builds the SQL condition
// against a surveys alias ('s' in the main query, 's2' in the mostRecent CTE).
// Tokens without an entry (incl. 'Comprehensive') are dropped, matching legacy.
const STATION_CONDS = {
  EF: (a) => `${a}.ef_stations > 0`,
  FN: (a) => `${a}.fn_stations > 0`,
  HN: (a) => `${a}.hn_stations > 0`,
};

// features.cpueEffectiveWire (MI): the wire `cpue` field must serve the
// effective CPUE (canonical fc.cpue_effective = legacy COALESCE(fc.cpue,
// fc.cpue_normalized)), not the raw per-gear fc.cpue which is NULL for the
// synthetic 'Mixed Gear Normalized' rows. Swap the `cpue` source expression for
// states that set the flag; every other state keeps raw fc.cpue (identical to
// cpue_effective for them, since their cpue_normalized is always NULL).
function cpueSrc(srcMap, entry) {
  const f = entry.features || {};
  if (!f.cpueEffectiveWire) return srcMap;
  return { ...srcMap, cpue: 'fc.cpue_effective AS cpue' };
}

function projectCols(fields, srcMap, what) {
  return fields.map(f => {
    const src = srcMap[f];
    if (!src) throw new Error(`no canonical source mapping for ${what} wire field '${f}'`);
    return src;
  }).join(',\n        ');
}

function mapOrder(spec) {
  return spec.split(',').map(tok => {
    const parts = tok.trim().split(/\s+/);
    const col = ORDER_SRC[parts[0]] || parts[0];
    return parts.length > 1 ? `${col} ${parts.slice(1).join(' ')}` : col;
  }).join(', ');
}

// ── Wire id type coercion ────────────────────────────────────────────────────
// Registry idWireType=integer states (SD, NE) store native integer ids in the
// canonical TEXT id columns; the shipped app expects JSON numbers, so cast the
// id-bearing wire fields back to numbers (123, not "123"). report_id is already
// an INTEGER column and is left untouched.
const INTEGER_ID_FIELDS = ['id', 'lake_id', 'survey_id'];
function coerceWireIds(entry, row) {
  if (!row || (entry.idWireType || 'text') !== 'integer') return;
  for (const k of INTEGER_ID_FIELDS) {
    if (typeof row[k] === 'string' && row[k] !== '') row[k] = Number(row[k]);
  }
}

// ── Query-plan pinning ─────────────────────────────────────────────────────
// The canonical artifacts carry ANALYZE stats plus indexes the legacy DBs
// don't have (idx_fc_gearcat, the fish_catch UNIQUE autoindex), so SQLite
// picks different plans — which changes the ARRIVAL order of rows into
// GROUP BY / ORDER BY / GROUP_CONCAT(DISTINCT), i.e. the ordering of ties.
// Wire parity requires reproducing the legacy planner's simple, stat-less
// choices, so the queries below pin the driving table/index explicitly:
//   species filter        -> fish_catch via idx_fc_species (legacy: idx_fish_catch_species)
//   county (no species)   -> lakes outer, fish_catch via idx_fc_lake
//   otherwise             -> full fish_catch scan (NOT INDEXED)
// CROSS JOIN is SQLite's documented "do not reorder" join. Verified
// byte-identical against legacy output by lakelore-data/bin/parity.js.

// Open the canonical DB for a state, or send the appropriate error response.
// Returns the db handle or null (response already sent).
function openDb(state, res, ctx) {
  const db = ctx.getDb(state);
  if (ctx.isUnhealthy(state)) {
    res.status(503).json({ error: 'state unhealthy: schema mismatch' });
    return null;
  }
  if (!db) {
    res.status(503).json({ error: 'Database not ready' });
    return null;
  }
  return db;
}

// ── /api/:state/filters ────────────────────────────────────────────────────────
// Replicates the legacy behavior against canonical columns:
// species -> species_native AS species; gear chips from gear_category
// (gearFilterMode 'gear') or station-presence counts + defaultGear
// (gearFilterMode 'stations', IA).

function filters(req, res, ctx) {
  const { state } = req.params;
  const db = openDb(state, res, ctx);
  if (!db) return;

  try {
    const entry = ctx.getStateEntry(state);
    const f = entry.features || {};
    const gearMode = f.gearFilterMode || 'gear';
    if (gearMode !== 'gear' && gearMode !== 'stations') {
      // MI mixed-mode chips land with that state's cutover.
      throw new Error(`canonical /filters not implemented for gearFilterMode=${f.gearFilterMode}`);
    }

    const hasCatch = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fish_catch'").get();

    // Optional county scope: when present, restrict the species lake_count
    // to lakes in those counties (mirrors legacy).
    const countyParam = req.query.county ? String(req.query.county) : '';
    const countyList = countyParam
      ? countyParam.split(',').map(c => c.trim()).filter(Boolean)
      : [];

    let species = [];
    if (hasCatch) {
      if (countyList.length > 0) {
        const placeholders = countyList.map(() => '?').join(',');
        // Plan pin (see header comment): drive from lakes like legacy did.
        species = db.prepare(`
          SELECT fc.species_native AS species, COUNT(DISTINCT fc.lake_id) as lake_count
          FROM fish_catch fc INDEXED BY idx_fc_lake
          JOIN lakes l ON l.id = fc.lake_id
          WHERE l.county IN (${placeholders})
          GROUP BY fc.species_native ORDER BY lake_count DESC
        `).all(...countyList);
      } else {
        species = db.prepare(`
          SELECT fc.species_native AS species, COUNT(DISTINCT fc.lake_id) as lake_count
          FROM fish_catch fc GROUP BY fc.species_native ORDER BY lake_count DESC
        `).all();
      }
    }

    const counties = db.prepare(`
      SELECT DISTINCT county FROM lakes WHERE county IS NOT NULL ORDER BY county
    `).all().map(r => r.county);

    const yearRange = hasCatch
      ? db.prepare('SELECT MIN(survey_year) as min, MAX(survey_year) as max FROM surveys').get()
      : { min: null, max: null };

    // Optional species filter: when set, gear counts reflect that species only.
    const speciesParam = req.query.species ? String(req.query.species) : null;
    const speciesAnd = speciesParam ? 'AND fc.species_native = ?' : '';
    const countyJoin = countyList.length > 0 ? 'JOIN lakes l ON l.id = fc.lake_id' : '';
    const countyAnd = countyList.length > 0
      ? `AND l.county IN (${countyList.map(() => '?').join(',')})`
      : '';
    const gearArgs = [
      ...(speciesParam ? [speciesParam] : []),
      ...countyList,
    ];

    let gearTypes = [];
    let gearTypeCounts = undefined;
    let gearCpueCounts = undefined;
    let gearLatestCounts = undefined;
    let defaultGear = undefined;
    if (gearMode === 'stations' && hasCatch) {
      // IA: gear chips derive from station-presence columns on surveys (EF/FN/HN)
      // plus the 'Comprehensive' survey-gear rollup — byte-identical port of the
      // legacy IA branch (fc.species -> fc.species_native is the only rename).
      const stationCount = (cond) => db.prepare(`
        SELECT COUNT(DISTINCT s.id) AS n
        FROM surveys s JOIN fish_catch fc ON fc.survey_id = s.id ${countyJoin}
        WHERE ${cond} ${speciesAnd} ${countyAnd}
      `).get(...gearArgs).n;
      const efN = stationCount('s.ef_stations > 0');
      const fnN = stationCount('s.fn_stations > 0');
      const hnN = stationCount('s.hn_stations > 0');
      const compN = stationCount("s.gear = 'Comprehensive'");
      if (efN) gearTypes.push('EF');
      if (fnN) gearTypes.push('FN');
      if (hnN) gearTypes.push('HN');
      if (compN) gearTypes.push('Comprehensive');
      if (gearTypes.length) {
        gearTypeCounts = { EF: efN, FN: fnN, HN: hnN, Comprehensive: compN };
        // Comprehensive rollups bundle multiple gear types — never the default
        // unless it's literally the only data for this species/county scope.
        const stationGears = gearTypes.filter(g => g !== 'Comprehensive');
        if (stationGears.length === 0) {
          defaultGear = 'Comprehensive';
        } else if (speciesParam || countyList.length > 0) {
          defaultGear = stationGears.slice().sort((a, b) => gearTypeCounts[b] - gearTypeCounts[a])[0];
        } else {
          defaultGear = fnN >= hnN && fnN > 0 ? 'FN' : hnN > 0 ? 'HN' : 'EF';
        }
      }
    } else if (hasCatch) {
      // Plan pin (see header comment): reproduce the legacy planner's driver.
      // Unfiltered case: states whose legacy DB had a gear index (SD) emitted the
      // gear list in gear (alphabetical) order — reproduced by driving
      // idx_fc_gearcat under features.gearListSorted. States without one (MN, ND)
      // full-scanned, giving arrival order — reproduced by NOT INDEXED.
      // Species/county cases keep their own driving index, whose arrival order the
      // legacy planner reproduced without a secondary sort.
      const fcPin = countyList.length > 0 ? 'INDEXED BY idx_fc_lake'
        : speciesParam ? 'INDEXED BY idx_fc_species'
        : (f.gearListSorted ? 'INDEXED BY idx_fc_gearcat' : 'NOT INDEXED');
      const gearRows = db.prepare(`
        SELECT fc.gear_category AS gear, COUNT(*) AS n
        FROM fish_catch fc ${fcPin} ${countyJoin}
        WHERE fc.gear_category IS NOT NULL ${speciesAnd} ${countyAnd}
        GROUP BY fc.gear_category ORDER BY n DESC
      `).all(...gearArgs);
      gearTypes = gearRows.map(r => r.gear);
      gearTypeCounts = Object.fromEntries(gearRows.map(r => [r.gear, r.n]));
      // Per-gear counts of CPUE-BEARING rows under the same species/county
      // scope (2026-07-15): several fleet states put a synthetic presence
      // bucket at the top of the raw counts, so the app picks its default
      // gear from these instead — otherwise the presence bucket hides the
      // real electrofishing/net survey rows (NC's "no Largemouth records").
      const gearCpueRows = db.prepare(`
        SELECT fc.gear_category AS gear, COUNT(*) AS n
        FROM fish_catch fc ${countyJoin}
        WHERE fc.gear_category IS NOT NULL AND fc.cpue_effective IS NOT NULL ${speciesAnd} ${countyAnd}
        GROUP BY fc.gear_category
      `).all(...gearArgs);
      gearCpueCounts = Object.fromEntries(gearCpueRows.map(r => [r.gear, r.n]));
      // Latest-aware per-gear counts (2026-08-11, owner report; REWRITTEN
      // 2026-08-12 after the 39-state sweep): the Filters modal showed
      // all-history row counts ("Standard gill nets: 333") while the list
      // under mostRecentOnly showed 43. v1 used COUNT(DISTINCT lake_id),
      // which is only correct when a species scopes the query — without one,
      // "latest" collapses per LAKE and the outer query returns every species
      // row of that survey, so no distinct-count matches. The count is now
      // computed with the SAME per-(gear,lake) most-recent semantics as
      // /results — and emitted ONLY under a species scope (the modal's real
      // case: the app requires a species to search; without one it falls
      // back to all-history counts). Date expression mirrors mostRecentBy,
      // including the null-date COALESCE fallback (the WA fix below).
      if (speciesParam && f.mostRecentBy !== 'stations') {
        const byDate = f.mostRecentBy === 'survey_date' || f.mostRecentBy === 'survey_date_not_null';
        const dateExpr = (a) => f.mostRecentBy === 'survey_date'
          ? `COALESCE(${a}.survey_date, CAST(${a}.survey_year AS TEXT))`
          : byDate ? `${a}.survey_date` : `${a}.survey_year`;
        const iaNotNull = f.mostRecentBy === 'survey_date_not_null' ? 'AND s2.survey_date IS NOT NULL' : '';
        const countyJoin2 = countyList.length > 0 ? 'JOIN lakes l2 ON l2.id = fc2.lake_id' : '';
        const countyAnd2 = countyList.length > 0
          ? `AND l2.county IN (${countyList.map(() => '?').join(',')})` : '';
        const gearLatestRows = db.prepare(`
          WITH _gear_recent AS (
            SELECT fc2.gear_category AS gear, fc2.lake_id AS lake_id, MAX(${dateExpr('s2')}) AS mx
            FROM surveys s2 JOIN fish_catch fc2 ON fc2.survey_id = s2.id ${countyJoin2}
            WHERE fc2.gear_category IS NOT NULL AND fc2.species_native = ? ${countyAnd2} ${iaNotNull}
            GROUP BY fc2.gear_category, fc2.lake_id
          )
          SELECT fc.gear_category AS gear, COUNT(*) AS n
          FROM fish_catch fc
          JOIN surveys s ON s.id = fc.survey_id
          JOIN _gear_recent gr ON gr.gear = fc.gear_category AND gr.lake_id = fc.lake_id
            AND ${dateExpr('s')} = gr.mx
          ${countyJoin}
          WHERE fc.species_native = ? ${countyAnd}
          GROUP BY fc.gear_category
        `).all(speciesParam, ...countyList, speciesParam, ...countyList);
        gearLatestCounts = Object.fromEntries(gearLatestRows.map(r => [r.gear, r.n]));
      }
    }

    const result = { species, gearTypes, gearTypeCounts, counties, yearRange };
    if (gearCpueCounts !== undefined) result.gearCpueCounts = gearCpueCounts;
    if (gearLatestCounts !== undefined) result.gearLatestCounts = gearLatestCounts;
    if (defaultGear !== undefined) result.defaultGear = defaultGear;

    if (f.surveyTypes) {
      result.surveyTypes = db.prepare(`
        SELECT DISTINCT survey_type FROM surveys WHERE survey_type IS NOT NULL ORDER BY survey_type
      `).all().map(r => r.survey_type);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── /api/:state/measures ─────────────────────────────────────────────────────
// Measure × Gear/Source manifest (DATA_MODEL_PROPOSAL_2026-07-20). Reshapes the
// prior flat "lens" list into the model the owner's notes describe: a small,
// stable set of MEASURES (Abundance / Avg Size / Stocking Impact / Presence) is
// the primary control, and GEAR/SOURCE is a required filter nested under
// Abundance & Avg Size. This fixes the 07-18 mistake of promoting every gear to
// a top-level choice (35 for MN pike). Measures are ordered by the default
// cascade: Abundance → Stocking Impact → Avg Size → Presence. Each source
// carries the exact (gear | cpueKind, sort, stockingFirst) to send to /results.
//
// Additive + parity-safe: NEW route, so /filters and /results goldens untouched.

// Rate/unit label for an abundance source. cpue_kind is authoritative per-row
// (schema v6), so a state that carries more than one kind (MB gear+relative,
// WI gear+normalized) yields more than one abundance source.
function deriveAbundanceUnit(gear, kind) {
  if (kind === 'relative') return 'index';
  if (kind === 'creel') return 'angler catch rate';
  if (kind === 'normalized') return 'norm. rate (all gear)';
  if (gear) {
    // Units are embedded in several gear strings, e.g.
    // "index gill net (fish/100yd net)" — surface the parenthetical rate.
    const m = gear.match(/\(([^)]*(?:\/|per |net|hr|min|mile|yd|hour|angler)[^)]*)\)\s*$/i);
    if (m) return m[1].trim();
  }
  return 'catch rate';
}

// Strip a trailing "(...)" unit annotation to get a clean gear display name.
function gearBaseName(gear) {
  return gear ? gear.replace(/\s*\([^)]*\)\s*$/, '').trim() : gear;
}

// The three abundance expressions from the notes, keyed by cpue_kind. Catch/unit
// and creel both read as a rate; relative/rating are rankings; normalized is its
// own cross-gear rate.
const ABUNDANCE_EXPRESSION = {
  gear: 'catch-per-unit', creel: 'catch-per-unit',
  relative: 'ranking', normalized: 'normalized',
};
const KIND_LABEL = {
  relative: 'Relative abundance', creel: 'Angler catch rate',
  normalized: 'Normalized catch rate',
};

function measures(req, res, ctx) {
  const { state } = req.params;
  const db = openDb(state, res, ctx);
  if (!db) return;

  try {
    const entry = ctx.getStateEntry(state);
    const wire = entry.wire || {};
    const wireResults = wire.results || [];
    const hasCatch = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fish_catch'").get();

    // Scope (mirror /filters): optional species + county.
    const speciesParam = req.query.species ? String(req.query.species) : null;
    const countyParam = req.query.county ? String(req.query.county) : '';
    const countyList = countyParam
      ? countyParam.split(',').map(c => c.trim()).filter(Boolean)
      : [];
    const speciesAnd = speciesParam ? 'AND fc.species_native = ?' : '';
    const countyJoin = countyList.length ? 'JOIN lakes l ON l.id = fc.lake_id' : '';
    const countyAnd = countyList.length
      ? `AND l.county IN (${countyList.map(() => '?').join(',')})`
      : '';
    const args = [...(speciesParam ? [speciesParam] : []), ...countyList];

    if (!hasCatch) {
      return res.json({ species: speciesParam, county: countyList, measures: [] });
    }

    const out = [];
    const canStock = wireResults.includes('stocked_per_100ac') || wireResults.includes('stocked_adults_est');
    // Avg Size resolves to length OR weight. Most states carry only one, but a
    // few carry BOTH on the wire — MI added a weight overlay on top of its
    // original length data (mostly the same rows); TN/GA creel report weight
    // alongside sparse/absent length. When both exist, pick the metric with MORE
    // real coverage in THIS scope — i.e. prefer length unless weight strictly
    // exceeds it — so we surface the richer metric (MI -> length, TN/GA ->
    // weight) and stay consistent with the scatter, instead of weight always
    // winning just because the column is present (the 2026-07-25 MI report).
    const hasWeightWire = wireResults.includes('average_weight');
    const hasLengthWire = wireResults.includes('average_length');
    let sizeField;
    if (hasWeightWire && hasLengthWire) {
      const sizeCount = (col) => db.prepare(`
        SELECT COUNT(*) AS n FROM fish_catch fc ${countyJoin}
        WHERE fc.${col} IS NOT NULL AND fc.${col} > 0 ${speciesAnd} ${countyAnd}
      `).get(...args).n;
      sizeField = sizeCount('average_weight') > sizeCount('average_length') ? 'average_weight' : 'average_length';
    } else if (hasWeightWire) {
      sizeField = 'average_weight';
    } else if (hasLengthWire) {
      sizeField = 'average_length';
    } else {
      sizeField = null;
    }

    // ── MEASURE: Abundance (sources = gear-cpue per gear, merged
    //    relative/creel/normalized per kind, and forecast rating). ──
    const abSources = [];

    // Gear-rate sources: one per gear_category. The gear/unit IS the
    // comparability distinction (fish/net-night ≠ fish/min-EF), so they never
    // merge. Client scopes /results by ?gear=<gear>.
    for (const r of db.prepare(`
      SELECT fc.gear_category AS gear,
             COUNT(*) AS records, COUNT(DISTINCT fc.lake_id) AS lakes
      FROM fish_catch fc ${countyJoin}
      WHERE fc.cpue_effective IS NOT NULL AND fc.gear_category IS NOT NULL
        AND (fc.cpue_kind = 'gear' OR fc.cpue_kind IS NULL)
        ${speciesAnd} ${countyAnd}
      GROUP BY fc.gear_category
    `).all(...args)) {
      abSources.push({
        id: `gear:${r.gear}`, gear: r.gear, cpueKind: null,
        expression: 'catch-per-unit', label: gearBaseName(r.gear),
        unit: deriveAbundanceUnit(r.gear, 'gear'),
        sort: 'cpue', sortDir: 'desc', stockingFirst: false,
        records: r.records, lakes: r.lakes,
      });
    }
    // Normalized catch rate — the ONE genuinely cross-gear comparable metric
    // (WI's α-calibrated rate). It is meant to be a single number spanning
    // gears, so it stays one merged source scoped by ?cpueKind=normalized.
    for (const r of db.prepare(`
      SELECT fc.cpue_kind AS kind,
             COUNT(*) AS records, COUNT(DISTINCT fc.lake_id) AS lakes
      FROM fish_catch fc ${countyJoin}
      WHERE fc.cpue_effective IS NOT NULL AND fc.cpue_kind = 'normalized'
        ${speciesAnd} ${countyAnd}
      GROUP BY fc.cpue_kind
    `).all(...args)) {
      abSources.push({
        id: `kind:${r.kind}`, gear: null, cpueKind: r.kind,
        expression: ABUNDANCE_EXPRESSION[r.kind] || 'ranking',
        label: KIND_LABEL[r.kind] || r.kind,
        unit: deriveAbundanceUnit(null, r.kind),
        sort: 'cpue', sortDir: 'desc', stockingFirst: false,
        records: r.records, lakes: r.lakes,
      });
    }
    // Relative + creel — each distinct gear_category is its OWN source, exactly
    // like the gear-rate sources above. A LIFA 0–5 rating, a % species
    // composition, and a historical gill-net index are NOT one comparable thing,
    // so merging them by cpue_kind produced an incoherent sort and a mixed-unit
    // list with no gear selected (the MB walleye bug). Each gear_category is
    // unique to one cpue_kind, so scoping /results by ?gear=<gear_category> is
    // exact. Default falls to whichever source (gear or relative) has the most
    // records, per the model.
    for (const r of db.prepare(`
      SELECT fc.gear_category AS gear, fc.cpue_kind AS kind,
             COUNT(*) AS records, COUNT(DISTINCT fc.lake_id) AS lakes
      FROM fish_catch fc ${countyJoin}
      WHERE fc.cpue_effective IS NOT NULL
        AND fc.cpue_kind IN ('relative', 'creel') AND fc.gear_category IS NOT NULL
        ${speciesAnd} ${countyAnd}
      GROUP BY fc.gear_category, fc.cpue_kind
    `).all(...args)) {
      abSources.push({
        id: `${r.kind}:${r.gear}`, gear: r.gear, cpueKind: null,
        expression: ABUNDANCE_EXPRESSION[r.kind] || 'ranking',
        label: gearBaseName(r.gear),
        unit: deriveAbundanceUnit(r.gear, r.kind),
        sort: 'cpue', sortDir: 'desc', stockingFirst: false,
        records: r.records, lakes: r.lakes,
      });
    }
    // Catch-all: relative/creel rows with NO gear_category can't be gear-scoped,
    // so keep a merged-by-kind source (scoped by ?cpueKind) so they aren't lost.
    // Rare — only where a state stored a relative value with no survey label.
    for (const r of db.prepare(`
      SELECT fc.cpue_kind AS kind,
             COUNT(*) AS records, COUNT(DISTINCT fc.lake_id) AS lakes
      FROM fish_catch fc ${countyJoin}
      WHERE fc.cpue_effective IS NOT NULL
        AND fc.cpue_kind IN ('relative', 'creel') AND fc.gear_category IS NULL
        ${speciesAnd} ${countyAnd}
      GROUP BY fc.cpue_kind
    `).all(...args)) {
      abSources.push({
        id: `kind:${r.kind}`, gear: null, cpueKind: r.kind,
        expression: ABUNDANCE_EXPRESSION[r.kind] || 'ranking',
        label: KIND_LABEL[r.kind] || r.kind,
        unit: deriveAbundanceUnit(null, r.kind),
        sort: 'cpue', sortDir: 'desc', stockingFirst: false,
        records: r.records, lakes: r.lakes,
      });
    }
    // Forecast-rating sources: one per gear_category rating bucket. Rating
    // states (GA/MO/IL/FL/KY/OK) can layer more than one rating SYSTEM over the
    // SAME lakes — e.g. GA's curated "Best Bet" list plus the standard "Forecast
    // Rating" — so a single merged rating source listed the same lake twice
    // (2026-07-21, GA Largemouth Bass: 43 rows / 29 lakes). Owner call: treat
    // each rating system exactly like a distinct gear type — its own source,
    // gear-scoped, one defaulted (most records), switchable via the gear/source
    // filter. Same-species duplicates disappear because only one bucket serves.
    for (const r of db.prepare(`
      SELECT fc.gear_category AS gear,
             COUNT(*) AS records, COUNT(DISTINCT fc.lake_id) AS lakes
      FROM fish_catch fc ${countyJoin}
      WHERE fc.rating_ordinal IS NOT NULL AND fc.gear_category IS NOT NULL
        ${speciesAnd} ${countyAnd}
      GROUP BY fc.gear_category
    `).all(...args)) {
      abSources.push({
        // `rating:` namespace, NOT `gear:` — a few states (AB/AR/WI) carry BOTH
        // a real CPUE and a forecast rating in the same gear_category bucket, so
        // a shared `gear:<g>` id collided with the catch-per-unit source above
        // (ambiguous defaultSourceId + React key collision). Distinct ids keep
        // the two abundance expressions for that gear separable.
        id: `rating:${r.gear}`, gear: r.gear, cpueKind: null, expression: 'ranking',
        label: gearBaseName(r.gear), unit: 'rating',
        sort: 'rating', sortDir: 'desc', stockingFirst: false,
        records: r.records, lakes: r.lakes,
      });
    }
    // Rating rows carrying no gear_category bucket still deserve a source.
    const rtNull = db.prepare(`
      SELECT COUNT(*) AS records, COUNT(DISTINCT fc.lake_id) AS lakes
      FROM fish_catch fc ${countyJoin}
      WHERE fc.rating_ordinal IS NOT NULL AND fc.gear_category IS NULL
        ${speciesAnd} ${countyAnd}
    `).get(...args);
    if (rtNull && rtNull.records > 0) {
      abSources.push({
        id: 'rating', gear: null, cpueKind: null, expression: 'ranking',
        label: 'Forecast rating', unit: 'rating',
        sort: 'rating', sortDir: 'desc', stockingFirst: false,
        records: rtNull.records, lakes: rtNull.lakes,
      });
    }
    if (abSources.length) {
      // Catch-per-unit gears lead, then rankings, then by coverage.
      const exprRank = { 'catch-per-unit': 0, normalized: 1, ranking: 2 };
      abSources.sort((a, b) =>
        (exprRank[a.expression] - exprRank[b.expression]) ||
        (b.records - a.records) || (b.lakes - a.lakes));
      out.push({
        id: 'abundance', label: 'Abundance', requiresSource: true,
        records: abSources.reduce((s, x) => s + x.records, 0),
        lakes: Math.max(...abSources.map(x => x.lakes)),
        sources: abSources,
      });
    }

    // ── MEASURE: Stocking Impact (survival-model rollup; own source). ──
    if (canStock) {
      const stkCountyJoin = countyList.length ? 'JOIN lakes l ON l.id = m.lake_id' : '';
      const stkSpeciesAnd = speciesParam ? 'AND m.species_native = ?' : '';
      const st = db.prepare(`
        SELECT COUNT(*) AS records, COUNT(DISTINCT m.lake_id) AS lakes,
               SUM(CASE WHEN m.adults_per_100ac IS NOT NULL THEN 1 ELSE 0 END) AS density
        FROM lake_stocking_metrics m ${stkCountyJoin}
        WHERE 1=1 ${stkSpeciesAnd} ${countyAnd}
      `).get(...args);
      if (st && st.records > 0) {
        out.push({
          id: 'stocking', label: 'Stocking Impact', requiresSource: false,
          records: st.records, lakes: st.lakes,
          sources: [{
            id: 'stocking', gear: null, cpueKind: null, expression: 'stocking',
            label: 'Stocking Impact',
            unit: st.density > 0 ? 'adults/100ac' : 'est. adults',
            sort: 'stocked', sortDir: 'desc', stockingFirst: true,
            records: st.records, lakes: st.lakes, densityRecords: st.density,
          }],
        });
      }
    }

    // ── MEASURE: Avg Size (length, or weight for MN; source = gear). ──
    if (sizeField) {
      const sizeSources = [];
      for (const r of db.prepare(`
        SELECT fc.gear_category AS gear,
               COUNT(*) AS records, COUNT(DISTINCT fc.lake_id) AS lakes,
               SUM(CASE WHEN fc.length_derivation = 'measured' THEN 1 ELSE 0 END) AS measured
        FROM fish_catch fc ${countyJoin}
        WHERE fc.${sizeField} IS NOT NULL AND fc.gear_category IS NOT NULL
          ${speciesAnd} ${countyAnd}
        GROUP BY fc.gear_category
      `).all(...args)) {
        sizeSources.push({
          id: `gear:${r.gear}`, gear: r.gear, cpueKind: null, expression: 'size',
          label: gearBaseName(r.gear),
          unit: sizeField === 'average_weight' ? 'lb' : 'in',
          sort: sizeField === 'average_weight' ? 'weight' : 'length',
          sortDir: 'desc', stockingFirst: false,
          records: r.records, lakes: r.lakes,
          measuredRecords: sizeField === 'average_length' ? r.measured : undefined,
        });
      }
      // Rows with size but NULL gear_category still deserve a source so the
      // measure is reachable (a few states carry length off a survey-level gear).
      const nullGear = db.prepare(`
        SELECT COUNT(*) AS records, COUNT(DISTINCT fc.lake_id) AS lakes
        FROM fish_catch fc ${countyJoin}
        WHERE fc.${sizeField} IS NOT NULL AND fc.gear_category IS NULL
          ${speciesAnd} ${countyAnd}
      `).get(...args);
      if (nullGear && nullGear.records > 0) {
        sizeSources.push({
          id: 'gear:__any__', gear: null, cpueKind: null, expression: 'size',
          label: 'All surveys',
          unit: sizeField === 'average_weight' ? 'lb' : 'in',
          sort: sizeField === 'average_weight' ? 'weight' : 'length',
          sortDir: 'desc', stockingFirst: false,
          records: nullGear.records, lakes: nullGear.lakes,
        });
      }
      if (sizeSources.length) {
        sizeSources.sort((a, b) => (b.records - a.records) || (b.lakes - a.lakes));
        out.push({
          id: 'size', label: 'Avg Size', requiresSource: true,
          records: sizeSources.reduce((s, x) => s + x.records, 0),
          lakes: Math.max(...sizeSources.map(x => x.lakes)),
          sources: sizeSources,
        });
      }
    }

    // ── MEASURE: Presence — DERIVED UNION of every lake+species across all
    //    measures (fish_catch ∪ lake_stocking_metrics), the guaranteed terminal
    //    fallback. Always present (owner call 2026-07-20). ──
    {
      const stkCountyJoin = countyList.length ? 'JOIN lakes l2 ON l2.id = m.lake_id' : '';
      const stkSpeciesAnd = speciesParam ? 'AND m.species_native = ?' : '';
      const stkCountyAnd = countyList.length
        ? `AND l2.county IN (${countyList.map(() => '?').join(',')})` : '';
      const stkArgs = canStock ? [...(speciesParam ? [speciesParam] : []), ...countyList] : [];
      const unionSql = `
        SELECT lake_id, species_native FROM fish_catch fc ${countyJoin}
        WHERE 1=1 ${speciesAnd} ${countyAnd}
        ${canStock ? `UNION
        SELECT m.lake_id, m.species_native FROM lake_stocking_metrics m ${stkCountyJoin}
        WHERE 1=1 ${stkSpeciesAnd} ${stkCountyAnd}` : ''}`;
      const pu = db.prepare(`
        SELECT COUNT(*) AS records, COUNT(DISTINCT lake_id) AS lakes
        FROM (SELECT DISTINCT lake_id, species_native FROM (${unionSql}))
      `).get(...args, ...stkArgs);
      out.push({
        id: 'presence', label: 'Presence', requiresSource: false,
        records: pu.records, lakes: pu.lakes,
        sources: [{
          id: 'presence', gear: null, cpueKind: null, expression: 'presence',
          label: 'Presence', unit: null,
          sort: null, sortDir: 'desc', stockingFirst: false, presenceUnion: true,
          records: pu.records, lakes: pu.lakes,
        }],
      });
    }

    // Measures already pushed in cascade order (abundance, stocking, size,
    // presence). The client defaults to the first with records; presence is the
    // terminal fallback. Stamp each measure's default source (most records).
    for (const m of out) {
      m.defaultSourceId = m.sources.slice()
        .sort((a, b) => (b.records - a.records) || (b.lakes - a.lakes))[0]?.id ?? null;
    }

    res.json({ species: speciesParam, county: countyList, measures: out });
  } catch (err) {
    console.error(`[${state}] /measures error:`, err);
    res.status(500).json({ error: err.message });
  }
}

// ── /api/:state/results ────────────────────────────────────────────────────────

function results(req, res, ctx) {
  const { state } = req.params;
  const db = openDb(state, res, ctx);
  if (!db) return;

  const hasCatch = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fish_catch'").get();
  if (!hasCatch) return res.json({ total: 0, results: [] });

  try {
    const entry = ctx.getStateEntry(state);
    const f = entry.features || {};
    const wire = entry.wire;
    if (!wire || !wire.results) throw new Error(`registry wire.results missing for canonical state ${state}`);

    const {
      species, lakeName, gear,
      minCpue, maxCpue,
      minYear, maxYear,
      county, minAcres, maxAcres,
      minStocked, maxStocked,
      minLength, maxLength,
      minCatch, maxCatch,
      mostRecentOnly,
      surveyType,
      minWeight, maxWeight,
      minGearCount, maxGearCount,
      sortBy = 'cpue',
      sortDir = 'desc',
      limit = '100',
      offset = '0',
      stockingFirst,
      presenceUnion,
    } = req.query;

    // Validate and clamp numeric query params (identical to legacy).
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    // Presence measure (DATA_MODEL §1): the DERIVED UNION of every lake+species
    // across all measures — fish_catch ∪ lake_stocking_metrics — so it's the
    // guaranteed terminal fallback that lists everything we know is present.
    // Opt-in via ?presenceUnion=1.
    if (presenceUnion === 'true' || presenceUnion === '1') {
      return presenceUnionResults(req, res, { db, state, entry, wire,
        species, county, lakeName, limitNum, offsetNum });
    }

    // Stocking measure (DATA_MODEL §1 / §5): drive results from
    // lake_stocking_metrics so stocked-but-unsurveyed lakes surface, with the
    // most-recent survey row LEFT-joined for any size/abundance we do have.
    // Opt-in via ?stockingFirst=1 — absent, the legacy fish_catch path below is
    // byte-identical, so the parity goldens are untouched.
    if (stockingFirst === 'true' || stockingFirst === '1') {
      return stockingFirstResults(req, res, { db, state, entry, wire, f,
        species, county, lakeName, minStocked, maxStocked, sortDir, limitNum, offsetNum });
    }

    const conditions = [];
    const params = [];

    if (species)          { conditions.push('fc.species_native = ?'); params.push(species); }
    if (lakeName?.trim()) { conditions.push('LOWER(l.name) LIKE LOWER(?)'); params.push(`%${lakeName.trim()}%`); }

    // cpueKind scope (DATA_MODEL_PROPOSAL_2026-07-20): the merged
    // relative/creel/normalized Abundance sources discriminate by cpue_kind
    // rather than a real sampling gear (their pseudo-gear isn't a method
    // distinction), so the client sends ?cpueKind=<kind> to confine a cpue sort
    // to one kind and never mix, e.g., a 0–5 relative index with a fish/net gear
    // rate. Optional — absent, the legacy path is byte-identical (parity
    // goldens untouched).
    const { cpueKind } = req.query;
    if (cpueKind) { conditions.push('fc.cpue_kind = ?'); params.push(String(cpueKind)); }

    if (gear) {
      const gears = gear.split(',').filter(Boolean);
      if (f.gearFilterMode === 'stations') {
        // IA: gear chips filter by station presence on the survey, not fc.gear.
        // Unknown tokens (incl. 'Comprehensive') drop out; if none remain, no
        // condition is added — exactly the legacy IA behavior.
        const conds = gears.map(g => STATION_CONDS[g] ? STATION_CONDS[g]('s') : null).filter(Boolean);
        if (conds.length) conditions.push(`(${conds.join(' OR ')})`);
      } else if (gears.length) {
        conditions.push(`fc.gear_category IN (${gears.map(() => '?').join(',')})`);
        params.push(...gears);
      }
    }

    if (minCpue !== undefined && minCpue !== '') { conditions.push('fc.cpue_effective >= ?'); params.push(parseFloat(minCpue)); }
    if (maxCpue !== undefined && maxCpue !== '') { conditions.push('fc.cpue_effective <= ?'); params.push(parseFloat(maxCpue)); }
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

    if (f.totalCatchFilter) {
      if (minCatch !== undefined && minCatch !== '') { conditions.push('fc.total_catch >= ?'); params.push(parseInt(minCatch, 10)); }
      if (maxCatch !== undefined && maxCatch !== '') { conditions.push('fc.total_catch <= ?'); params.push(parseInt(maxCatch, 10)); }
    }

    if (f.lengthFilter) {
      // IA (lengthFilterMeasuredOnly): the legacy min/maxLength filter compared
      // raw fc.average_length, NOT the size-class estimate the SELECT coalesced
      // in — so rows whose canonical average_length was baked from
      // ia_size_classes (length_derivation='estimate') must be treated as NULL
      // here, keeping filter semantics byte-identical to legacy.
      const lengthCol = f.lengthFilterMeasuredOnly
        ? "(CASE WHEN fc.length_derivation = 'estimate' THEN NULL ELSE fc.average_length END)"
        : 'fc.average_length';
      if (minLength !== undefined && minLength !== '') { conditions.push(`${lengthCol} >= ?`); params.push(parseFloat(minLength)); }
      if (maxLength !== undefined && maxLength !== '') { conditions.push(`${lengthCol} <= ?`); params.push(parseFloat(maxLength)); }
    }

    if (f.surveyTypes && surveyType) {
      const types = surveyType.split(',').filter(Boolean);
      if (types.length) { conditions.push(`s.survey_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
    }
    if (f.weightFilter) {
      if (minWeight !== undefined && minWeight !== '') { conditions.push('fc.average_weight >= ?'); params.push(parseFloat(minWeight)); }
      if (maxWeight !== undefined && maxWeight !== '') { conditions.push('fc.average_weight <= ?'); params.push(parseFloat(maxWeight)); }
    }
    if (f.gearCountFilter) {
      if (minGearCount !== undefined && minGearCount !== '') { conditions.push('fc.gear_count >= ?'); params.push(parseInt(minGearCount, 10)); }
      if (maxGearCount !== undefined && maxGearCount !== '') { conditions.push('fc.gear_count <= ?'); params.push(parseInt(maxGearCount, 10)); }
    }

    // ── mostRecentOnly CTE — date expression keyed by registry mostRecentBy ──
    let ctePrefix = '';
    const cteParams = [];
    let mostRecentJoin = '';

    if (mostRecentOnly === 'true') {
      const subConds = [];
      if (species) { subConds.push('fc2.species_native = ?'); cteParams.push(species); }
      if (gear) {
        const gears = gear.split(',').filter(Boolean);
        if (f.gearFilterMode === 'stations') {
          const gconds = gears.map(g => STATION_CONDS[g] ? STATION_CONDS[g]('s2') : null).filter(Boolean);
          if (gconds.length) subConds.push(`(${gconds.join(' OR ')})`);
        } else if (gears.length) {
          subConds.push(`fc2.gear_category IN (${gears.map(() => '?').join(',')})`);
          cteParams.push(...gears);
        }
      }
      // Scope the most-recent computation to the same comparability class as the
      // outer filter (DATA_MODEL): without this, "most recent survey per lake"
      // spans all kinds, so a relative/creel/normalized source loses every lake
      // whose latest survey happened to be a gear row. cpueKind is only sent by
      // the measure model, so legacy goldens never hit this (parity-safe).
      if (cpueKind) { subConds.push('fc2.cpue_kind = ?'); cteParams.push(String(cpueKind)); }
      // IA: exclude consolidated rollup rows from the most-recent calculation.
      if (f.mostRecentBy === 'survey_date_not_null') subConds.push('s2.survey_date IS NOT NULL');

      const subWhere = subConds.length ? 'WHERE ' + subConds.join(' AND ') : '';

      if (f.mostRecentBy === 'survey_date' || f.mostRecentBy === 'survey_date_not_null') {
        // Presence checklists must not define "most recent" (credibility #1,
        // 2026-07-28): a species list stamped with the scrape year hid a
        // lake's genuine surveys behind mostRecentOnly. Real rows win; lakes
        // with ONLY presence rows fall back so they still appear.
        //
        // Null-date surveys rank by YEAR (2026-08-12, 39-state sweep): under
        // plain 'survey_date', a NULL date never equals max_date, so a survey
        // carrying only survey_year was UNRANKABLE — WA's entire warmwater
        // overlay (347 of 593 surveys) was invisible under mostRecentOnly,
        // the app's default view, since it shipped. COALESCE to the bare year
        // string: 'YYYY' sorts before any 'YYYY-MM-DD' of the same year (a
        // dated survey beats a year-only one in-year) and after every prior
        // year — sane, deterministic ordering. IA's 'survey_date_not_null'
        // keeps excluding null dates on purpose (consolidated rollups), and
        // MN/MT carry zero null dates, so their bytes cannot change.
        const dExpr = (a) => f.mostRecentBy === 'survey_date'
          ? `COALESCE(${a}.survey_date, CAST(${a}.survey_year AS TEXT))`
          : `${a}.survey_date`;
        ctePrefix = `WITH _most_recent AS (
          SELECT s2.lake_id, COALESCE(
            MAX(CASE WHEN fc2.gear_category IS NULL OR fc2.gear_category != 'Presence Only' THEN ${dExpr('s2')} END),
            MAX(${dExpr('s2')})) AS max_date
          FROM surveys s2 JOIN fish_catch fc2 ON fc2.survey_id = s2.id ${subWhere}
          GROUP BY s2.lake_id
        )`;
        // CROSS JOIN pins mr LAST (legacy planner joined the materialized CTE
        // last via an automatic index; canonical's ANALYZE stats made it the
        // driver, permuting tie order).
        mostRecentJoin = `CROSS JOIN _most_recent mr ON mr.lake_id = l.id AND ${dExpr('s')} = mr.max_date`;
      } else {
        ctePrefix = `WITH _most_recent AS (
          SELECT s2.lake_id, COALESCE(
            MAX(CASE WHEN fc2.gear_category IS NULL OR fc2.gear_category != 'Presence Only' THEN s2.survey_year END),
            MAX(s2.survey_year)) AS max_year
          FROM surveys s2 JOIN fish_catch fc2 ON fc2.survey_id = s2.id ${subWhere}
          GROUP BY s2.lake_id
        )`;
        mostRecentJoin = 'CROSS JOIN _most_recent mr ON mr.lake_id = l.id AND s.survey_year = mr.max_year';
      }
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Output projected EXACTLY per registry wire.results — plus a hidden
    // fc.gear_category (stripped in finishResults) that drives the
    // presence-row year-nulling below.
    const selectCols = projectCols(wire.results, cpueSrc(RESULTS_SRC, entry), 'results') + ", fc.gear_category AS _gcat";

    // Canonical DBs precompute lake_stocking_metrics for EVERY state, so the
    // stocked sort/JOIN is SQL always (no JS post-sort branch).
    const extraJoins = 'LEFT JOIN lake_stocking_metrics lsm ON lsm.lake_id = fc.lake_id AND lsm.species_native = fc.species_native';

    const SORT_COLS = {
      cpue: 'fc.cpue_effective',
      lake: 'l.name', acres: 'l.area_acres', year: 's.survey_year',
      stocked: 'lsm.adults_per_100ac',
      weight: 'fc.average_weight', catch: 'fc.total_catch',
      date: f.mostRecentBy === 'survey_date_not_null'
        ? "COALESCE(s.survey_date, CAST(s.survey_year AS TEXT) || '-12-31')"
        : 's.survey_date',
      depth: 'l.max_depth_feet',
      length: 'fc.average_length',
      rating: 'fc.rating_ordinal',
      psd: 'fc.psd', psd_p: 'fc.psd_p', wr: 'fc.wr',
      wr_sq: 'fc.wr_sq', wr_qp: 'fc.wr_qp', wr_pm: 'fc.wr_pm', wr_m: 'fc.wr_m',
    };
    const sortCol = SORT_COLS[sortBy] ?? 'fc.cpue_effective';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
    // Stocked sort ranks in two blocks (2026-07-15): lakes WITH acreage by
    // density first, then acreage-less stocked lakes by absolute estimated
    // adults (adults_est). NULLS LAST keeps never-stocked rows at the bottom.
    // cpue sort (2026-07-17): rows WITH a catch rate rank first by cpue; rows
    // WITHOUT one (net count unstated, or mixed-gear catch that can't be split
    // per gear — common in the PDF-extracted states) fall below them and are
    // then ordered by raw total_catch DESC, so "90 fish, rate unknown" outranks
    // "7 fish, rate unknown". The CASE guard confines the total_catch tiebreak
    // to the null-cpue block, so rows with a real cpue keep their exact prior
    // order (no tie-order regression for the legacy-parity states).
    const sortExpr = sortBy === 'stocked'
      ? `(lsm.adults_per_100ac IS NULL) ASC, COALESCE(lsm.adults_per_100ac, lsm.adults_est) ${dir} NULLS LAST`
      : sortBy === 'cpue'
      ? `(fc.cpue_effective IS NULL) ASC, fc.cpue_effective ${dir}, (CASE WHEN fc.cpue_effective IS NULL THEN fc.total_catch END) DESC`
      : null;

    // mostRecentOrderPin (NE): for species-less mostRecentOnly queries the
    // legacy planner drives the _most_recent CTE as the OUTER table (verified
    // by EXPLAIN QUERY PLAN for every species-less variant), so rows ARRIVE in
    // (numeric lake_id ASC [CTE emission order via idx_surveys_lake], raw fc
    // rowid ASC within lake [idx_fish_catch_lake]) order — which is what breaks
    // sort-key ties. Canonical fish_catch.id preserves raw rowid order 1:1
    // (adapter inserts in raw scan order), so an explicit ORDER BY suffix
    // reproduces the legacy tie order deterministically, independent of the
    // canonical planner. Species queries keep the species-index arrival (their
    // own pin); legacy uses idx_fish_catch_species there too.
    let orderSuffix = '';
    if (f.mostRecentOrderPin && mostRecentOnly === 'true' && !species) {
      const lakeKey = (entry.idWireType || 'text') === 'integer'
        ? 'CAST(fc.lake_id AS INTEGER)' : 'fc.lake_id';
      orderSuffix = `, ${lakeKey}, fc.id`;
    }

    // Plan pin (see header comment): fix the join order + driving index to the
    // shape the legacy planner picked, so tie order matches byte-for-byte.
    // Registry-gated variants (verified by EXPLAIN QUERY PLAN on the raw DBs):
    //   countyPin=false  (NE)     — the raw DB has no idx_lakes_county, so the
    //     legacy planner full-scanned fish_catch even for county queries.
    //   yearRangePin=true (IA/NE) — the raw DB has idx_surveys_year and the
    //     legacy planner drives BOTH-bounds year-range queries through it
    //     (surveys in year order), but only when species/county don't provide
    //     a driver and no _most_recent CTE is present. One-sided year bounds
    //     stay on the full scan (legacy behavior; verified). ND's raw DB has
    //     the same index but its parity corpus is tie-clean without the pin,
    //     so ND keeps the proven full-scan shape.
    const bothYearBounds = minYear !== undefined && minYear !== ''
      && maxYear !== undefined && maxYear !== '';
    let pinnedFrom;
    if (species) {
      pinnedFrom = `FROM fish_catch fc INDEXED BY idx_fc_species
      CROSS JOIN surveys s ON fc.survey_id = s.id
      CROSS JOIN lakes l ON fc.lake_id = l.id`;
    } else if (county && f.countyPin !== false) {
      // Drive lakes via idx_lakes_county so the scan visits lakes in county
      // order — matches the legacy planner's covering-index choice and keeps the
      // arrival order (hence tie order among equal sort keys) identical.
      pinnedFrom = `FROM lakes l INDEXED BY idx_lakes_county
      CROSS JOIN fish_catch fc INDEXED BY idx_fc_lake ON fc.lake_id = l.id
      CROSS JOIN surveys s ON fc.survey_id = s.id`;
    } else if (f.yearRangePin && bothYearBounds && mostRecentOnly !== 'true') {
      pinnedFrom = `FROM surveys s INDEXED BY idx_surveys_year
      CROSS JOIN fish_catch fc INDEXED BY idx_fc_survey ON fc.survey_id = s.id
      CROSS JOIN lakes l ON fc.lake_id = l.id`;
    } else {
      pinnedFrom = `FROM fish_catch fc NOT INDEXED
      CROSS JOIN surveys s ON fc.survey_id = s.id
      CROSS JOIN lakes l ON fc.lake_id = l.id`;
    }

    const joinsSql = `
      ${pinnedFrom}
      ${extraJoins}
      ${mostRecentJoin}
      ${whereClause}
    `;

    const allParams = [...cteParams, ...params];
    const total = db.prepare(`${ctePrefix} SELECT COUNT(*) as n ${joinsSql}`).get(allParams).n;

    let rows = db.prepare(`
      ${ctePrefix}
      SELECT ${selectCols} ${joinsSql}
      ORDER BY ${sortExpr ?? `${sortCol} ${dir} NULLS LAST`}${orderSuffix}
      LIMIT ? OFFSET ?
    `).all([...allParams, limitNum, offsetNum]);

    // stocked range post-filter (identical to legacy semantics).
    if (minStocked !== undefined && minStocked !== '') {
      rows = rows.filter(r => r.stocked_per_100ac != null && r.stocked_per_100ac >= parseFloat(minStocked));
    }
    if (maxStocked !== undefined && maxStocked !== '') {
      rows = rows.filter(r => r.stocked_per_100ac != null && r.stocked_per_100ac <= parseFloat(maxStocked));
    }

    return finishResults(req, res, state, entry, rows, total);
  } catch (err) {
    console.error(`[${state}] /results (canonical) error:`, err);
    res.status(500).json({ error: err.message });
  }
}

// Shared results tail: id coercion + preview redaction. Used by both the legacy
// fish_catch path and the stocking-first path so identity redaction and id
// hashing stay in one place.
function finishResults(req, res, state, entry, rows, total) {
  for (const r of rows) coerceWireIds(entry, r);

  // Presence rows are species lists, not surveys — serving the SCRAPE year
  // as survey_year was the fleet's #1 credibility lie (a "2026" checklist
  // outranked genuine 2025 gill-net surveys in ~40 states). The app renders
  // a null year as "no survey date". Ratings keep their year (a 2026
  // forecast is honestly a 2026 forecast).
  for (const r of rows) {
    if (r._gcat === 'Presence Only') { r.survey_year = null; r.survey_date = null; }
    delete r._gcat;
  }

  // Preview mode (non-subscriber browsing a paid state — flag set by the
  // entitlement middleware): every metric ships, but lake identity is withheld
  // server-side so identifying fields never reach an unentitled device. The
  // client renders a blurred placeholder where the name would go and drops the
  // county/acres line. lake_id stays on the wire — it keys rows/scatter dots
  // and the (also-redacted) /lake/:id fetch.
  if (req.lakeLorePreview) {
    for (const r of rows) {
      redactPreviewFields(r, PREVIEW_REDACT_RESULT);
      if (r.lake_id != null) r.lake_id = previewId(state, String(r.lake_id));
      if (r.survey_id != null) r.survey_id = previewId(state, String(r.survey_id));
    }
    return res.json({ total, preview: true, results: rows });
  }
  return res.json({ total, results: rows });
}

// Stocking Impact measure results (DATA_MODEL_PROPOSAL_2026-07-20). Drives from
// lake_stocking_metrics rather than fish_catch, LEFT-joining the most-recent
// survey row per lake+species so a stocked-but-unsurveyed lake still appears
// (with NULL abundance/size) and a surveyed one shows its latest metrics
// alongside the stocking figure. Ranks density-then-absolute like the legacy
// stocked sort. Reuses the wire.results projection so the row shape is identical
// to the normal path; goes through finishResults for preview redaction.
function stockingFirstResults(req, res, opts) {
  const { db, state, entry, wire, species, county, lakeName, minStocked, maxStocked,
          sortDir, limitNum, offsetNum } = opts;
  try {
    const countyList = county
      ? String(county).split(',').map(c => c.trim()).filter(Boolean)
      : [];
    const conds = [];
    const args = [];
    if (species) { conds.push('m.species_native = ?'); args.push(String(species)); }
    // Honor lake-name search on the stocking measure too (the presence-union
    // path already does). Without this, typing a lake name while on Stocking
    // Impact returned the unfiltered stocked list — results looked wrong.
    if (lakeName && lakeName.trim()) { conds.push('LOWER(l.name) LIKE LOWER(?)'); args.push(`%${lakeName.trim()}%`); }
    if (countyList.length) {
      conds.push(`l.county IN (${countyList.map(() => '?').join(',')})`);
      args.push(...countyList);
    }
    const whereClause = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

    // wire.results projection, but sourced from m (stocking) + l (lake) + the
    // LEFT-joined most-recent fc/s. The stocked_* fields read m.* here.
    const src = { ...RESULTS_SRC,
      stocked_per_100ac: 'm.adults_per_100ac AS stocked_per_100ac',
      stocked_adults_est: 'm.adults_est AS stocked_adults_est',
      species: 'm.species_native AS species',
      species_name: 'COALESCE(fc.species_name, m.species_name) AS species_name',
    };
    const selectCols = projectCols(wire.results, cpueSrc(src, entry), 'results');

    // At most one fc row (most recent survey) per stocked lake+species.
    const joins = `
      FROM lake_stocking_metrics m
      JOIN lakes l ON l.id = m.lake_id
      LEFT JOIN fish_catch fc ON fc.id = (
        SELECT fc2.id FROM fish_catch fc2
        JOIN surveys s2 ON s2.id = fc2.survey_id
        WHERE fc2.lake_id = m.lake_id AND fc2.species_native = m.species_native
        ORDER BY s2.survey_year DESC, fc2.id DESC LIMIT 1)
      LEFT JOIN surveys s ON s.id = fc.survey_id
      ${whereClause}`;

    const total = db.prepare(`SELECT COUNT(*) AS n ${joins}`).get(...args).n;
    let rows = db.prepare(`
      SELECT ${selectCols} ${joins}
      ORDER BY (m.adults_per_100ac IS NULL) ASC,
               COALESCE(m.adults_per_100ac, m.adults_est) ${dir} NULLS LAST,
               l.name ASC
      LIMIT ? OFFSET ?
    `).all(...args, limitNum, offsetNum);

    if (minStocked !== undefined && minStocked !== '') {
      rows = rows.filter(r => r.stocked_per_100ac != null && r.stocked_per_100ac >= parseFloat(minStocked));
    }
    if (maxStocked !== undefined && maxStocked !== '') {
      rows = rows.filter(r => r.stocked_per_100ac != null && r.stocked_per_100ac <= parseFloat(maxStocked));
    }

    return finishResults(req, res, state, entry, rows, total);
  } catch (err) {
    console.error(`[${state}] /results stockingFirst error:`, err);
    res.status(500).json({ error: err.message });
  }
}

// Presence-measure results (DATA_MODEL §1): the derived UNION of every
// lake+species we know is present — fish_catch (abundance/size/presence rows)
// ∪ lake_stocking_metrics (stocked, incl. never-surveyed lakes) — one row per
// lake+species, with the most-recent survey row's metrics LEFT-joined where
// they exist. This is the guaranteed terminal fallback in the measure cascade.
// Reuses wire.results so the row shape matches the normal path; preview
// redaction goes through finishResults.
function presenceUnionResults(req, res, opts) {
  const { db, state, entry, wire, species, county, lakeName, limitNum, offsetNum } = opts;
  try {
    const wireResults = wire.results || [];
    const canStock = wireResults.includes('stocked_per_100ac') || wireResults.includes('stocked_adults_est');
    const countyList = county
      ? String(county).split(',').map(c => c.trim()).filter(Boolean)
      : [];

    // Build the union key-set (lake_id, species_native), scoped to species/county.
    const fcConds = [], fcArgs = [];
    if (species) { fcConds.push('fc.species_native = ?'); fcArgs.push(String(species)); }
    const fcWhere = fcConds.length ? 'WHERE ' + fcConds.join(' AND ') : '';
    const stkConds = [], stkArgs = [];
    if (species) { stkConds.push('m.species_native = ?'); stkArgs.push(String(species)); }
    const stkWhere = stkConds.length ? 'WHERE ' + stkConds.join(' AND ') : '';

    const unionKeys = `
      SELECT DISTINCT lake_id, species_native FROM (
        SELECT fc.lake_id, fc.species_native FROM fish_catch fc ${fcWhere}
        ${canStock ? `UNION
        SELECT m.lake_id, m.species_native FROM lake_stocking_metrics m ${stkWhere}` : ''}
      )`;

    // Project wire.results from the union, joined to the lake and the most-recent
    // fc row per key (for any metrics), and the stocking metric row.
    const src = { ...RESULTS_SRC,
      lake_id: 'k.lake_id AS lake_id',
      species: 'k.species_native AS species',
      species_name: 'COALESCE(fc.species_name, m.species_name) AS species_name',
      stocked_per_100ac: 'm.adults_per_100ac AS stocked_per_100ac',
      stocked_adults_est: 'm.adults_est AS stocked_adults_est',
    };
    const selectCols = projectCols(wire.results, cpueSrc(src, entry), 'results');

    const outConds = [], outArgs = [];
    if (lakeName && lakeName.trim()) { outConds.push('LOWER(l.name) LIKE LOWER(?)'); outArgs.push(`%${lakeName.trim()}%`); }
    if (countyList.length) { outConds.push(`l.county IN (${countyList.map(() => '?').join(',')})`); outArgs.push(...countyList); }
    const outWhere = outConds.length ? 'WHERE ' + outConds.join(' AND ') : '';

    const joins = `
      FROM (${unionKeys}) k
      JOIN lakes l ON l.id = k.lake_id
      LEFT JOIN fish_catch fc ON fc.id = (
        SELECT fc2.id FROM fish_catch fc2
        JOIN surveys s2 ON s2.id = fc2.survey_id
        WHERE fc2.lake_id = k.lake_id AND fc2.species_native = k.species_native
        ORDER BY s2.survey_year DESC, fc2.id DESC LIMIT 1)
      LEFT JOIN surveys s ON s.id = fc.survey_id
      ${canStock ? 'LEFT JOIN lake_stocking_metrics m ON m.lake_id = k.lake_id AND m.species_native = k.species_native' : ''}
      ${outWhere}`;
    // When the state can't stock, there's no m table alias — null the stocked cols.
    const joinsFixed = canStock ? joins
      : joins.replace('m.adults_per_100ac', 'NULL').replace('m.adults_est', 'NULL').replace('m.species_name', 'NULL');

    const allArgs = [...fcArgs, ...stkArgs, ...outArgs];
    const total = db.prepare(`SELECT COUNT(*) AS n ${joinsFixed}`).get(...allArgs).n;
    const rows = db.prepare(`
      SELECT ${selectCols} ${joinsFixed}
      ORDER BY l.name ASC, k.species_native ASC
      LIMIT ? OFFSET ?
    `).all(...allArgs, limitNum, offsetNum);

    return finishResults(req, res, state, entry, rows, total);
  } catch (err) {
    console.error(`[${state}] /results presenceUnion error:`, err);
    res.status(500).json({ error: err.message });
  }
}

// ── /api/:state/lake/:id ───────────────────────────────────────────────────────

function lakeDetail(req, res, ctx) {
  const { state } = req.params;
  let { id } = req.params;
  // Leading/embedded spaces are allowed (2026-07-25): IN carries 15 lakes
  // whose SOURCE ids are space-prefixed (' -17', ' -149', …) — the old
  // /^[\w-]+$/ 400'd every detail tap on them for entitled users (preview
  // users were unaffected via hashed ids). Found by the T3.2 deep-readyz
  // wire probe. Still no dots/slashes — path-traversal stays impossible.
  if (!/^[\w -]{1,128}$/.test(id)) return res.status(400).json({ error: 'Invalid lake id' });
  const db = openDb(state, res, ctx);
  if (!db) return;

  // Hashed preview id (from a preview /results payload) — resolve back to the
  // real lake id. Resolved regardless of entitlement so a user who subscribes
  // mid-session can still open a detail screen reached from cached preview
  // results.
  if (PREVIEW_ID_RE.test(id)) {
    const real = resolvePreviewLakeId(state, db, id);
    if (!real) return res.status(404).json({ error: 'Lake not found' });
    id = real;
  }

  try {
    const entry = ctx.getStateEntry(state);
    const f = entry.features || {};
    const wire = entry.wire;
    if (!wire || !wire.lakeSurveys || !wire.lakeCatches) {
      throw new Error(`registry wire lake lists missing for canonical state ${state}`);
    }

    // Canonical lake shape (SELECT *): drops legacy-internal columns and
    // renames avg_water_clarity -> water_clarity; whitelisted in parity notes.
    const lake = db.prepare('SELECT * FROM lakes WHERE id = ?').get(id);
    if (!lake) return res.status(404).json({ error: 'Lake not found' });

    const hasCatch = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fish_catch'").get();

    // ── Surveys ──────────────────────────────────────────────────────────────
    // INDEXED BY idx_fc_survey pin: without it the planner covers the join
    // from the fish_catch UNIQUE autoindex, which feeds species into
    // GROUP_CONCAT(DISTINCT ...) alphabetically instead of in legacy rowid order.
    // species_list: some states' legacy DBs fed GROUP_CONCAT(DISTINCT) from a
    // (survey_id, species, …) covering index, so the list came out in species
    // order (features.speciesListSorted); others got rowid order via idx_fc_survey.
    // Reproduce each explicitly (ORDER BY inside the aggregate vs. the idx pin).
    const surveysSrc = f.speciesListSorted
      ? { ...LAKE_SURVEYS_SRC, species_list: 'GROUP_CONCAT(DISTINCT fc.species_native ORDER BY fc.species_native) as species_list' }
      : LAKE_SURVEYS_SRC;
    const surveyCols = projectCols(wire.lakeSurveys, surveysSrc, 'lakeSurveys');
    // Deterministic tie-break for surveys sharing the primary sort key. Legacy
    // broke ties by native survey id; for idWireType=integer states that is a
    // NUMERIC order, so cast the stringified canonical id back.
    let surveysOrder = mapOrder(wire.lakeSurveysOrder);
    if ((entry.idWireType || 'text') === 'integer') surveysOrder += ', CAST(s.id AS INTEGER)';
    const surveys = db.prepare(`
      SELECT ${surveyCols}
      FROM surveys s LEFT JOIN fish_catch fc INDEXED BY idx_fc_survey ON fc.survey_id = s.id
      WHERE s.lake_id = ? GROUP BY s.id ORDER BY ${surveysOrder}
    `).all(id);

    // ── Catches ───────────────────────────────────────────────────────────────
    let catches = [];
    if (hasCatch) {
      const catchCols = projectCols(wire.lakeCatches, cpueSrc(LAKE_CATCHES_SRC, entry), 'lakeCatches');
      catches = db.prepare(`
        SELECT ${catchCols}
        FROM fish_catch fc INDEXED BY idx_fc_lake JOIN surveys s ON s.id = fc.survey_id
        WHERE fc.lake_id = ? ORDER BY ${mapOrder(wire.lakeCatchesOrder)}
      `).all(id);
    }

    // ── Stocking ──────────────────────────────────────────────────────────────
    // Canonical column is species_native; aliased to `species` on the wire
    // (legacy: SELECT stock_year, species, life_stage, SUM(quantity) ...).
    let stocking = [];
    try {
      stocking = db.prepare(`
        SELECT stock_year, species_native AS species, life_stage, SUM(quantity) as quantity
        FROM stocking WHERE lake_id = ?
        GROUP BY stock_year, species, life_stage ORDER BY stock_year DESC, species
      `).all(id);
    } catch { /* stocking table may not exist */ }

    // ── Stocking metrics — same on-the-fly compute path as legacy ────────────
    // metricsV2=1 (1.1.0+ clients) opts into absolute adults_est metrics for
    // acreage-less lakes; without it those lakes return empty metrics so
    // shipped 1.0.x builds never see a null adults_per_100ac.
    const { metrics, metrics_by_year } = ctx.computeLakeStockingMetrics(
      state, lake.area_acres, stocking, req.query.metricsV2 === '1');

    // Registry-gated report link (SD): surface the most recent survey that
    // actually contributed stocking rows, so the Stocking-tab link lands on a
    // PDF that has the data. Mirrors legacy server.js SD /lake behavior. For
    // states without the flag this stays null (legacy returns null too).
    let latest_stocking_report_id = null;
    if (f.stockingReportId) {
      try {
        const orderId = (entry.idWireType || 'text') === 'integer' ? 'CAST(s.id AS INTEGER)' : 's.id';
        const row = db.prepare(`
          SELECT s.report_id
          FROM surveys s JOIN stocking st ON st.survey_id = s.id
          WHERE s.lake_id = ?
          ORDER BY s.survey_year DESC, ${orderId} DESC
          LIMIT 1
        `).get(id);
        latest_stocking_report_id = row?.report_id ?? null;
      } catch { /* stocking table may not exist */ }
    }

    coerceWireIds(entry, lake);
    for (const r of surveys) coerceWireIds(entry, r);
    for (const r of catches) coerceWireIds(entry, r);

    // Preview mode: serve the full CPUE/stocking detail, but withhold every
    // field that identifies the lake — name/county/acres/coords on the lake
    // row, plus report ids and source-PDF/URL links on surveys and catches
    // (those documents name the lake). Metrics were already computed above
    // from the real area_acres, so per-100-acre numbers stay correct.
    if (req.lakeLorePreview) {
      redactPreviewLakeAllowlist(lake);
      if (lake.id != null) lake.id = previewId(state, String(lake.id));
      for (const s of surveys) {
        redactPreviewFields(s, PREVIEW_REDACT_DOC_LINKS);
        if (s.id != null) s.id = previewId(state, String(s.id));
      }
      for (const c of catches) {
        redactPreviewFields(c, PREVIEW_REDACT_DOC_LINKS);
        if (c.survey_id != null) c.survey_id = previewId(state, String(c.survey_id));
      }
      return res.json({
        lake, surveys, catches, stocking, metrics, metrics_by_year,
        latest_stocking_report_id: null, preview: true,
      });
    }

    res.json({ lake, surveys, catches, stocking, metrics, metrics_by_year, latest_stocking_report_id });
  } catch (err) {
    console.error(`[${state}] /lake/${id} (canonical) error:`, err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { filters, measures, results, lakeDetail, clearPreviewLakeIdMap };
