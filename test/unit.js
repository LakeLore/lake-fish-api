#!/usr/bin/env node
'use strict';
// test/unit.js — behaviours the smoke test cannot reach because they need a
// misbehaving upstream or a production-mode server:
//   · a hung RevenueCat call is abandoned at the deadline (grace for known
//     subscribers, a plain negative for everyone else)
//   · POST /ask is closed in production without LAKELORE_ASK_TOKEN, 403s a
//     wrong token, and stops at the daily ceiling
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error(`FAIL ${msg}`); } };

async function rcTimeout() {
  process.env.REVENUECAT_SECRET_KEY = 'test';
  process.env.REVENUECAT_PROJECT_ID = 'test';
  process.env.REVENUECAT_TIMEOUT_MS = '150';
  process.env.LAKELORE_GRACE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'll-unit-')), 'grace.json');
  const realFetch = global.fetch;
  let mode = 'hang';
  global.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
    const isList = String(url).includes('/entitlements?');
    if (mode === 'ok' || (mode === 'list-hangs' && !isList)) {
      const body = String(url).includes('/entitlements?')
        ? { items: [{ id: 'entl_1', lookup_key: 'LakeLore All-States' }] }
        : { items: [{ entitlement_id: 'entl_1', expires_at: null }] };
      return resolve({ ok: true, status: 200, json: async () => body });
    }
    // Never answers; only the caller's deadline can end it.
    opts.signal?.addEventListener('abort', () => reject(opts.signal.reason));
  });
  const ent = require('../entitlement');

  let t0 = Date.now();
  const stranger = await bounded(ent.checkEntitlement('stranger'));
  ok(Date.now() - t0 < 1500, `hung RC lookup took ${Date.now() - t0} ms (deadline 150)`);
  ok(stranger.hasAllStates === false && stranger.source === 'rc-error', `stranger during RC hang: ${JSON.stringify(stranger)}`);

  mode = 'ok';
  const paid = await ent.checkEntitlement('subscriber');
  ok(paid.hasAllStates === true, `subscriber with RC healthy: ${JSON.stringify(paid)}`);
  mode = 'hang';
  ent.invalidateCache('subscriber');
  ent._resetAllStatesEntitlementId();
  t0 = Date.now();
  const graced = await bounded(ent.checkEntitlement('subscriber'));
  ok(graced.hasAllStates === true && graced.source === 'grace', `known subscriber during RC hang: ${JSON.stringify(graced)}`);
  ok(Date.now() - t0 < 1500, `graced lookup took ${Date.now() - t0} ms`);

  // The entitlement-id lookup times out while the per-customer call answers:
  // "no match" must not read as an authoritative "not subscribed".
  mode = 'list-hangs';
  ent.invalidateCache('subscriber');
  ent._resetAllStatesEntitlementId();
  const partial = await bounded(ent.checkEntitlement('subscriber'));
  ok(partial.hasAllStates === true && partial.source === 'grace', `subscriber when only the id lookup hangs: ${JSON.stringify(partial)}`);
  ent.invalidateCache('stranger');
  const partialStranger = await bounded(ent.checkEntitlement('stranger'));
  ok(partialStranger.source === 'rc-error', `stranger when only the id lookup hangs: ${JSON.stringify(partialStranger)}`);
  global.fetch = realFetch;
}

// A lookup that never settles (a dropped signal) must fail the test, not hang deploy.sh.
function bounded(p, ms = 3000) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`lookup did not settle in ${ms} ms`)), ms).unref())]);
}

// The slow-query row cache stores RAW rows that subscribers and preview users
// share; redaction has to run on each copy handed out. Driven in-process with
// the threshold at 0 so every page query is cached, across all three call
// sites, with each entitlement populating an entry the other then reads.
function rowCache() {
  process.env.LAKELORE_ROWS_CACHE_MIN_MS = '0';
  process.env.PREVIEW_ID_SECRET = process.env.PREVIEW_ID_SECRET || 'unit-test-only';
  const Database = require('better-sqlite3');
  const canonical = require('../server/canonical.js');
  const ld = require(path.join(os.homedir(), 'lakelore-data'));
  const db = new Database(path.join(os.homedir(), 'lakelore-data', 'out', 'tx.db'), { readonly: true });
  const ctx = { getDb: () => db, isUnhealthy: () => false, getStateEntry: s => ld.getState(s), computeLakeStockingMetrics: () => ({}) };
  const call = (query, preview, extra = {}) => {
    const r = { statusCode: 200 }; r.status = c => (r.statusCode = c, r); r.json = b => (r.body = b, r);
    canonical.results({ params: { state: 'tx' }, query, get: () => undefined, lakeLorePreview: preview, ...extra }, r, ctx);
    ok(r.statusCode === 200, `tx results ${JSON.stringify(query)} -> ${r.statusCode}`);
    return r.body;
  };
  const redacted = b => b.preview === true && b.results.length > 0 && b.results.every(r =>
    r.lake_name == null && r.county == null && r.latitude == null && r.longitude == null && r.area_acres == null
    && /^p[0-9a-f]+$/.test(String(r.lake_id)));
  const named = b => !b.preview && b.results.length > 0 && b.results.some(r => r.lake_name) && b.results.every(r => !/^p[0-9a-f]{15}$/.test(String(r.lake_id)));
  let n = 0;
  for (const q of [{}, { stockingFirst: '1' }, { presenceUnion: '1' }, { sortBy: 'lake' }, { stockingFirst: '1', minStocked: '1' }]) {
    for (const order of [[false, true, false, true], [true, false, true, false]]) {
      const query = { ...q, limit: String(40 + n++) };   // a fresh key per pass, so each order populates its own entry
      const before = canonical.rowsCacheStats().hits;
      const seen = { true: [], false: [] };
      for (const pv of order) {
        const b = call(query, pv);
        ok(pv ? redacted(b) : named(b), `${JSON.stringify(query)} preview=${pv}: ${pv ? 'identity in a preview answer' : 'a subscriber answer lost its lake names'} (order ${order})`);
        seen[pv].push(JSON.stringify(b));
      }
      ok(seen.true[0] === seen.true[1] && seen.false[0] === seen.false[1], `${JSON.stringify(query)}: a cached answer differs from the first one`);
      ok(canonical.rowsCacheStats().hits > before, `${JSON.stringify(query)}: no cache hit — the cache is not in the path`);
    }
  }
  // The readiness probe's flag must bypass the cache entirely.
  const h = canonical.rowsCacheStats();
  call({ limit: '40' }, false, { lakeLoreNoCache: true });
  const h2 = canonical.rowsCacheStats();
  ok(h2.hits === h.hits && h2.misses === h.misses, 'lakeLoreNoCache request touched the row cache');
  canonical.clearTotalCache('tx');
  ok(canonical.rowsCacheStats().entries === 0 && canonical.rowsCacheStats().bytes === 0, 'clearTotalCache left row-cache entries or bytes behind');
  db.close();
}

async function withServer(env, fn) {
  const port = 3198;
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production', LAKELORE_ASK_ENABLED: '1',
      SENTRY_DSN: '', ANTHROPIC_API_KEY: '', LAKELORE_JWT_SECRET: 'unit-test-only', PREVIEW_ID_SECRET: 'unit-test-only', LAKELORE_ASK_TOKEN: '', LAKELORE_ASK_PUBLIC: '', ...env },
    stdio: 'ignore',
  });
  await new Promise(r => setTimeout(r, 3500));
  const ask = async (headers = {}, body = '{}') => {
    const res = await fetch(`http://localhost:${port}/api/mn/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
    });
    let error = null;
    try { error = (await res.json()).error; } catch { /* non-json */ }
    return `${res.status} ${error}`;
  };
  try { await fn(ask); } finally { server.kill(); await new Promise(r => setTimeout(r, 300)); }
}

// The image is built from allow-lists (deploy/Dockerfile COPY lines and
// deploy/.dockerignore). A server file that is required but not listed in BOTH
// boots fine locally and crashes the deployed image at startup.
function imageShipsEveryRequiredFile() {
  const root = path.join(__dirname, '..');
  const dockerfile = fs.readFileSync(path.join(root, 'deploy', 'Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(root, 'deploy', '.dockerignore'), 'utf8');
  const seen = new Set();
  const queue = ['server.js'];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const shipped = `lake-fish-mobile-server/${rel}`;
    ok(dockerfile.includes(`COPY ${shipped} `), `${rel} is required at runtime but has no COPY line in deploy/Dockerfile`);
    ok(ignore.includes(`!${shipped}\n`), `${rel} is required at runtime but is not allow-listed in deploy/.dockerignore`);
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of src.matchAll(/require\(['"](\.\.?\/[^'"]+)['"]\)/g)) {
      let target = path.normalize(path.join(path.dirname(rel), m[1]));
      if (target.startsWith('..')) continue; // ../lakelore-data is copied as a tree
      if (!target.endsWith('.js') && !target.endsWith('.json')) target += '.js';
      queue.push(target);
    }
  }
}

(async () => {
  imageShipsEveryRequiredFile();
  // AbortSignal.timeout's timer is unref'd and the stubbed fetch holds no
  // socket, so without this the process would exit mid-test.
  const keepAlive = setInterval(() => {}, 1000);
  await rcTimeout();

  // An empty body is rejected by the ask handler's own validation (400
  // bad_request) before any model call, so that answer means "past the gate".
  await withServer({}, async (ask) => {
    ok(await ask() === '503 ask_unavailable', 'production /ask without a configured token must be closed');
  });
  rowCache();
  // A well-formed ask against an unroutable model endpoint: it passes
  // validation, spends budget, then fails upstream — no real model call.
  const real = JSON.stringify({ messages: [{ role: 'user', content: 'walleye lakes?' }] });
  const T = { 'X-Ask-Token': 'sesame' };
  await withServer({ LAKELORE_ASK_TOKEN: 'sesame', LAKELORE_ASK_DAILY_MAX: '2',
    ANTHROPIC_API_KEY: 'unit-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, async (ask) => {
    ok(await ask() === '403 ask_forbidden', '/ask without the token must 403');
    ok(await ask({ 'X-Ask-Token': 'wrong' }) === '403 ask_forbidden', '/ask with a wrong token must 403');
    for (let i = 0; i < 4; i++) ok(await ask(T) === '400 bad_request', 'an invalid body must be rejected without spending budget');
    const a1 = await ask(T, real), a2 = await ask({ ...T, 'X-User-Id': 'someone-else' }, real);
    ok(!a1.includes('ask_unavailable') && !a2.includes('ask_unavailable'), `asks inside the ceiling must reach the model call: ${a1} / ${a2}`);
    ok(await ask(T, real) === '503 ask_unavailable', '/ask past the daily ceiling must 503 ask_unavailable');
  });

  if (failures) { console.error(`\nUNIT FAILED — ${failures} failure(s)`); process.exit(1); }
  console.log('UNIT OK — RevenueCat deadline, /ask gate');
  process.exit(0);
})().catch(err => { console.error('unit test crashed:', err); process.exit(1); });
