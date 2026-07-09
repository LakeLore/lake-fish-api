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
  cpue_ci: 'fc.cpue_ci',
  average_length: 'fc.average_length',
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
  cpue_ci: 'fc.cpue_ci',
  cpue_all_gear: 'fc.cpue_all_gear',
  cpue_normalized: 'fc.cpue_normalized',
  average_weight: 'fc.average_weight',
  weight_lbs: 'fc.weight_lbs',
  total_catch: 'fc.total_catch',
  sample_n: 'fc.sample_n',
  gear_count: 'fc.gear_count',
  average_length: 'fc.average_length',
  min_length: 'fc.min_length',
  max_length: 'fc.max_length',
  n_measured: 'fc.n_measured',
  quartile_count_low: 'fc.quartile_count_low',
  quartile_count_high: 'fc.quartile_count_high',
  psd: 'fc.psd', psd_p: 'fc.psd_p', wr: 'fc.wr',
  wr_sq: 'fc.wr_sq', wr_qp: 'fc.wr_qp', wr_pm: 'fc.wr_pm', wr_m: 'fc.wr_m',
  n_sq: 'fc.n_sq', n_qp: 'fc.n_qp', n_pm: 'fc.n_pm', n_m: 'fc.n_m',
  ef_stations: 's.ef_stations', hn_stations: 's.hn_stations', fn_stations: 's.fn_stations',
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
    }

    const result = { species, gearTypes, gearTypeCounts, counties, yearRange };
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
    } = req.query;

    // Validate and clamp numeric query params (identical to legacy).
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    const conditions = [];
    const params = [];

    if (species)          { conditions.push('fc.species_native = ?'); params.push(species); }
    if (lakeName?.trim()) { conditions.push('LOWER(l.name) LIKE LOWER(?)'); params.push(`%${lakeName.trim()}%`); }

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
      // IA: exclude consolidated rollup rows from the most-recent calculation.
      if (f.mostRecentBy === 'survey_date_not_null') subConds.push('s2.survey_date IS NOT NULL');

      const subWhere = subConds.length ? 'WHERE ' + subConds.join(' AND ') : '';

      if (f.mostRecentBy === 'survey_date' || f.mostRecentBy === 'survey_date_not_null') {
        ctePrefix = `WITH _most_recent AS (
          SELECT s2.lake_id, MAX(s2.survey_date) AS max_date
          FROM surveys s2 JOIN fish_catch fc2 ON fc2.survey_id = s2.id ${subWhere}
          GROUP BY s2.lake_id
        )`;
        // CROSS JOIN pins mr LAST (legacy planner joined the materialized CTE
        // last via an automatic index; canonical's ANALYZE stats made it the
        // driver, permuting tie order).
        mostRecentJoin = 'CROSS JOIN _most_recent mr ON mr.lake_id = l.id AND s.survey_date = mr.max_date';
      } else {
        ctePrefix = `WITH _most_recent AS (
          SELECT s2.lake_id, MAX(s2.survey_year) AS max_year
          FROM surveys s2 JOIN fish_catch fc2 ON fc2.survey_id = s2.id ${subWhere}
          GROUP BY s2.lake_id
        )`;
        mostRecentJoin = 'CROSS JOIN _most_recent mr ON mr.lake_id = l.id AND s.survey_year = mr.max_year';
      }
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Output projected EXACTLY per registry wire.results.
    const selectCols = projectCols(wire.results, cpueSrc(RESULTS_SRC, entry), 'results');

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
      psd: 'fc.psd', psd_p: 'fc.psd_p', wr: 'fc.wr',
      wr_sq: 'fc.wr_sq', wr_qp: 'fc.wr_qp', wr_pm: 'fc.wr_pm', wr_m: 'fc.wr_m',
    };
    const sortCol = SORT_COLS[sortBy] ?? 'fc.cpue_effective';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

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
      ORDER BY ${sortCol} ${dir} NULLS LAST${orderSuffix}
      LIMIT ? OFFSET ?
    `).all([...allParams, limitNum, offsetNum]);

    // stocked range post-filter (identical to legacy semantics).
    if (minStocked !== undefined && minStocked !== '') {
      rows = rows.filter(r => r.stocked_per_100ac != null && r.stocked_per_100ac >= parseFloat(minStocked));
    }
    if (maxStocked !== undefined && maxStocked !== '') {
      rows = rows.filter(r => r.stocked_per_100ac != null && r.stocked_per_100ac <= parseFloat(maxStocked));
    }

    for (const r of rows) coerceWireIds(entry, r);

    // Preview mode (non-subscriber browsing a paid state — flag set by the
    // entitlement middleware): every metric ships, but lake identity is
    // withheld server-side so names never reach an unentitled device. The
    // client renders a blurred placeholder where the name would go. lake_id
    // stays on the wire — it keys rows/scatter dots, and /lake/:id is still
    // 402-gated so the id alone reveals nothing.
    if (req.lakeLorePreview) {
      for (const r of rows) r.lake_name = null;
      return res.json({ total, preview: true, results: rows });
    }
    res.json({ total, results: rows });
  } catch (err) {
    console.error(`[${state}] /results (canonical) error:`, err);
    res.status(500).json({ error: err.message });
  }
}

// ── /api/:state/lake/:id ───────────────────────────────────────────────────────

function lakeDetail(req, res, ctx) {
  const { state, id } = req.params;
  if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: 'Invalid lake id' });
  const db = openDb(state, res, ctx);
  if (!db) return;

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
    const { metrics, metrics_by_year } = ctx.computeLakeStockingMetrics(state, lake.area_acres, stocking);

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

    res.json({ lake, surveys, catches, stocking, metrics, metrics_by_year, latest_stocking_report_id });
  } catch (err) {
    console.error(`[${state}] /lake/${id} (canonical) error:`, err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { filters, results, lakeDetail };
