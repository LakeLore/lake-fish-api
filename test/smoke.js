#!/usr/bin/env node
'use strict';
// test/smoke.js — endpoint smoke test across every active state
// (IMPROVEMENT_PLAN 1.12). Spawns the server against the local lakelore-data
// artifacts and asserts, per state:
//   /status 200 ready · /filters 200 · /results rows + preview redaction
//   (identity fields null, ids hashed) · /lake/:id via a hashed preview id
//   (redacted + metrics served) · deactivated states 400.
//
//   npm test        (exits nonzero on any failure)
const { spawn } = require('child_process');

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
const REDACTED = ['lake_name', 'county', 'area_acres', 'latitude', 'longitude',
  'location', 'report_id', 'source_pdf', 'source_url'];
const HASHED_ID = /^p[0-9a-f]{15}$/;

const registry = require('../../lakelore-data/registry/states.json').states;
const ACTIVE = Object.keys(registry).filter(s => registry[s].active);
const INACTIVE = Object.keys(registry).filter(s => !registry[s].active);
const FREE = new Set(Object.keys(registry).filter(s => registry[s].free));

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL ${msg}`); };
const get = async (p) => {
  const res = await fetch(BASE + p);
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
};

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  await new Promise(r => setTimeout(r, 3500));

  try {
    const ready = await get('/readyz');
    if (ready.status !== 200) fail(`/readyz ${ready.status}: ${JSON.stringify(ready.body)}`);

    for (const st of ACTIVE) {
      const status = await get(`/api/${st}/status`);
      if (status.status !== 200 || !status.body?.ready) { fail(`${st} /status ${status.status}`); continue; }

      const filters = await get(`/api/${st}/filters`);
      if (filters.status !== 200 || !Array.isArray(filters.body?.species)) fail(`${st} /filters ${filters.status}`);

      const results = await get(`/api/${st}/results?limit=2&sortBy=cpue&sortDir=desc&mostRecentOnly=true`);
      if (results.status !== 200) { fail(`${st} /results ${results.status}`); continue; }
      const rows = results.body?.results ?? [];
      if (FREE.has(st)) {
        if (rows[0] && rows[0].lake_name == null) fail(`${st} free state missing lake_name`);
        continue;
      }
      // Paid state, no user id -> preview with identity redacted + hashed ids.
      if (results.body?.preview !== true) fail(`${st} /results not preview`);
      for (const r of rows) {
        for (const f of REDACTED) if (r[f] != null) fail(`${st} preview leak ${f}=${r[f]}`);
        if (r.lake_id != null && !HASHED_ID.test(String(r.lake_id))) fail(`${st} raw lake_id ${r.lake_id}`);
      }
      if (rows[0]) {
        const lake = await get(`/api/${st}/lake/${rows[0].lake_id}?metricsV2=1`);
        if (lake.status !== 200 || lake.body?.preview !== true) fail(`${st} /lake preview ${lake.status}`);
        else {
          if (lake.body.lake?.name != null) fail(`${st} /lake preview name leak`);
          for (const s of lake.body.surveys ?? []) {
            for (const f of ['report_id', 'source_pdf', 'source_url']) if (s[f] != null) fail(`${st} /lake survey leak ${f}`);
          }
        }
      }
    }

    for (const st of INACTIVE) {
      const r = await get(`/api/${st}/status`);
      if (r.status !== 400) fail(`inactive ${st} /status expected 400, got ${r.status}`);
    }

    console.log(failures === 0
      ? `SMOKE OK — ${ACTIVE.length} active states clean, ${INACTIVE.length} inactive 400`
      : `${failures} failures`);
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
})();
