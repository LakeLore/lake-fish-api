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
const path = require('path');
const Database = require('better-sqlite3');
const OUT_DIR = path.join(__dirname, '..', '..', 'lakelore-data', 'out');

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
        const idx = await get(`/api/${st}/lakes-index`);
        if (idx.status !== 200 || !(idx.body?.lakes?.length > 0)) fail(`${st} free-state /lakes-index ${idx.status}`);
        const byName = await get(`/api/${st}/results?lakeName=lake&limit=1`);
        if (byName.status !== 200) fail(`${st} free-state lakeName search ${byName.status}`);
        continue;
      }
      // Paid state, no user id -> preview with identity redacted + hashed ids.
      if (results.body?.preview !== true) fail(`${st} /results not preview`);
      for (const r of rows) {
        for (const f of REDACTED) if (r[f] != null) fail(`${st} preview leak ${f}=${r[f]}`);
        if (r.lake_id != null && !HASHED_ID.test(String(r.lake_id))) fail(`${st} raw lake_id ${r.lake_id}`);
      }
      // Path-shape variants must stay gated (2026-10-07: /Results skipped the
      // case-sensitive gate and served full identity with no credentials).
      // %-encoded state: Express decodes :state but req.path stays encoded, so
      // the path gate never matches — only the handlers' enforcePreview covers it.
      const encSt = '%' + st.charCodeAt(0).toString(16) + st[1];
      for (const variant of [`/api/${st}/Results`, `/api/${st}/RESULTS`, `/api/${st}/results/`, `/API/${st}/results`, `/api/${encSt}/results`]) {
        const v = await get(`${variant}?limit=2&sortBy=cpue&sortDir=desc&mostRecentOnly=true`);
        if (v.status !== 200) continue; // not routed at all is fine
        if (v.body?.preview !== true) fail(`${st} ${variant} not preview`);
        for (const r of v.body?.results ?? []) {
          for (const f of REDACTED) if (r[f] != null) fail(`${st} ${variant} leak ${f}=${r[f]}`);
          if (r.lake_id != null && !HASHED_ID.test(String(r.lake_id))) fail(`${st} ${variant} raw lake_id`);
        }
      }
      // A RAW lake id must 402 in preview on every path shape.
      // Raw ids + names come straight from the artifact: /lakes-index is
      // subscriber-only for paid states since 2026-10-07.
      const sdb = new Database(path.join(OUT_DIR, `${st}.db`), { readonly: true });
      const sample = sdb.prepare("SELECT id, name FROM lakes WHERE name IS NOT NULL AND length(name) >= 4 ORDER BY id LIMIT 1").get();
      sdb.close();
      const rawId = sample?.id;
      for (const p of [`/api/${st}/lakes-index`, `/api/${st}/Lakes-Index`, `/api/${encSt}/lakes-index`]) {
        const v = await get(p);
        if (v.status !== 402) fail(`${st} ${p} expected 402 without entitlement, got ${v.status}`);
      }
      // Naming a lake in preview is subscriber-only (identity oracle).
      if (sample) for (const base of [`/api/${st}/results`, `/api/${st}/Results`, `/api/${encSt}/results`]) {
        for (const extra of ['', '&presenceUnion=1', '&stockingFirst=true']) {
          const v = await get(`${base}?lakeName=${encodeURIComponent(sample.name)}${extra}`);
          if (v.status !== 402) fail(`${st} ${base}?lakeName=…${extra} expected 402 in preview, got ${v.status}`);
        }
      }
      // Name-ordered preview pages must come back in keyed-id order, not name order.
      for (const q of ['presenceUnion=1&limit=50', 'sortBy=lake&sortDir=asc&limit=50']) {
        const v = await get(`/api/${st}/results?${q}`);
        const ids = (v.body?.results ?? []).map(r => String(r.lake_id));
        if (v.status !== 200) fail(`${st} /results?${q} ${v.status}`);
        else if (ids.some((id, i) => i > 0 && id < ids[i - 1])) fail(`${st} /results?${q} preview rows not in keyed-id order`);
      }
      if (rawId == null) fail(`${st} artifact gave no raw id to probe with`);
      else for (const base of [`/api/${st}/lake`, `/api/${st}/Lake`, `/api/${st}/LAKE`, `/api/${encSt}/lake`]) {
        const v = await get(`${base}/${encodeURIComponent(rawId)}`);
        if (v.status !== 402) fail(`${st} ${base}/<raw id> expected 402 without entitlement, got ${v.status}`);
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

    // client-config carries the served state list (1.1.2+ clients use it to
    // hide a pulled state instead of dead-ending on a 400).
    {
      const cc = await get('/api/client-config');
      const served = cc.body?.states?.active;
      if (!Array.isArray(served) || served.join() !== [...ACTIVE].sort().join()) fail(`client-config states.active mismatch: ${JSON.stringify(served)?.slice(0, 80)}`);
    }

    for (const st of INACTIVE) {
      const r = await get(`/api/${st}/status`);
      if (r.status !== 400) fail(`inactive ${st} /status expected 400, got ${r.status}`);
    }

    // lastWebhookAt assertion (post-launch item, 2026-08-25): a webhook POST
    // must land in the rc stats — the entitlement-freshness path's only
    // heartbeat. Regression here = renewals silently degrade to the 5-min
    // cache TTL with no evidence anywhere. Unsigned POST is accepted outside
    // production (NODE_ENV=test here), so no secret is needed.
    {
      const before = await get('/healthz?deep=1');
      const wh = await fetch(BASE + '/webhooks/revenuecat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: { app_user_id: 'smoke-test-user', type: 'TEST' } }),
      });
      if (wh.status !== 200) fail(`/webhooks/revenuecat ${wh.status}`);
      const after = await get('/healthz?deep=1');
      const rc = after.body?.rc;
      if (!rc?.lastWebhookAt) fail('rc.lastWebhookAt not set after webhook POST');
      else if (Date.parse(rc.lastWebhookAt) < Date.now() - 60_000) fail(`rc.lastWebhookAt stale: ${rc.lastWebhookAt}`);
      if (!((rc?.webhooksTotal ?? 0) > (before.body?.rc?.webhooksTotal ?? 0))) fail('rc.webhooksTotal did not increment');
      if (typeof rc?.webhookAgeHours !== 'number') fail('rc.webhookAgeHours missing from deep healthz');
    }

    console.log(failures === 0
      ? `SMOKE OK — ${ACTIVE.length} active states clean, ${INACTIVE.length} inactive 400`
      : `${failures} failures`);
  } finally {
    server.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
})();
