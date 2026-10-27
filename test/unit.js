#!/usr/bin/env node
'use strict';
// test/unit.js — behaviours the smoke test cannot reach because they need a
// misbehaving upstream or a production-mode server:
//   · a hung RevenueCat call is abandoned at the deadline (grace for known
//     subscribers, a plain negative for everyone else)
//   · POST /ask is closed in production without LAKELORE_ASK_TOKEN, 403s a
//     wrong token, and stops at the daily ceiling
//   · /ask against a fake Anthropic API (mockModel): quotas, the out-of-credit
//     and spend-limit 400s, refunds on failure, counts that survive a restart,
//     and /ask/report
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

// A stand-in for api.anthropic.com. mode 'ok' answers every call with a
// one-line final answer; the other modes answer with the 400s the real API
// sends when the money runs out.
const mock = { mode: 'ok', calls: 0, lastBody: null, delayMs: 0 };
const MOCK_ERRORS = {
  credit: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  other: 'messages.0.content: text content blocks must be non-empty',
  limit: 'You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
};
function mockModel() {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      mock.calls++;
      try { mock.lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { mock.lastBody = null; }
      if (mock.delayMs) await new Promise(r => setTimeout(r, mock.delayMs));
      if (res.destroyed) return;
      res.setHeader('content-type', 'application/json');
      if (mock.mode !== 'ok') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: MOCK_ERRORS[mock.mode] } }));
      }
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Try a deep lake with rock reefs.' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
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
  const model = await mockModel();
  const M = { ANTHROPIC_API_KEY: 'unit-test', ANTHROPIC_BASE_URL: model.url };
  await withServer({ LAKELORE_ASK_TOKEN: 'sesame', LAKELORE_ASK_DAILY_MAX: '2', LAKELORE_ASK_SUBSCRIBERS_ONLY: '0', ...M }, async (ask) => {
    ok(await ask() === '403 ask_forbidden', '/ask without the token must 403');
    ok(await ask({ 'X-Ask-Token': 'wrong' }) === '403 ask_forbidden', '/ask with a wrong token must 403');
    for (let i = 0; i < 4; i++) ok(await ask(T) === '400 bad_request', 'an invalid body must be rejected without spending budget');
    // Failed model calls give the machine budget back, and a 400 that is not
    // about money stays a plain upstream error.
    mock.mode = 'credit';
    for (let i = 0; i < 3; i++) ok(await ask(T, real) === '503 ask_out_of_credit', 'an exhausted credit must 503 ask_out_of_credit');
    mock.mode = 'other';
    let o = await ask(T, real); ok(o === '502 ask_upstream', `a non-credit 400 must 502 ask_upstream: ${o}`);
    mock.mode = 'ok';
    const a1 = await ask(T, real), a2 = await ask({ ...T, 'X-User-Id': 'someone-else' }, real);
    ok(a1 === '200 undefined' && a2 === '200 undefined', `asks inside the ceiling must get an answer: ${a1} / ${a2}`);
    ok(await ask(T, real) === '503 ask_unavailable', '/ask past the daily ceiling must 503 ask_unavailable');
  });

  // Production launch shape (2026-10-20): public route, subscribers only.
  // Without RevenueCat keys a production server treats everyone as not
  // entitled, so the free state's ask must 402 too, and client-config must
  // advertise the assistant.
  await withServer({ LAKELORE_ASK_PUBLIC: '1', ANTHROPIC_API_KEY: 'unit-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', LAKELORE_ASK_UNLIMITED_USERS: 'owner-phone' }, async (ask) => {
    ok(await ask({ 'X-User-Id': 'free-user' }, real) === '402 subscription_required', 'subscribers-only /ask must 402 a free-state ask without a subscription');
    ok(await ask({}, real) === '402 subscription_required', 'subscribers-only /ask must 402 a request with no user id');
    ok(await ask({ 'X-User-Id': 'owner-phone' }, real) === '402 subscription_required', 'an unlimited-list id still needs a subscription');
    const cfg = await (await fetch('http://localhost:3198/api/client-config')).json();
    ok(cfg.ask && cfg.ask.enabled === true, `client-config must advertise ask.enabled: ${JSON.stringify(cfg.ask)}`);
  });
  // Per-subscriber daily quota. Outside production a missing RevenueCat key
  // counts as entitled, which stands in for a subscriber here.
  // The volume is a temp dir (MN_DB_PATH keeps the real MN data), so the
  // saved counts, chat logs and reports can be checked and survive a restart.
  const vol = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-unit-'));
  const SUB = { NODE_ENV: 'development', REVENUECAT_SECRET_KEY: '', REVENUECAT_PROJECT_ID: '', LAKELORE_ASK_USER_DAILY_MAX: '1',
    LAKELORE_DB_DIR: vol, MN_DB_PATH: path.join(__dirname, '..', '..', 'lakelore-data', 'out', 'mn.db'), ...M };
  const U = { 'X-User-Id': 'subscriber-1' };
  await withServer(SUB, async (ask) => {
    // Out of credit, and past the workspace spend limit: a kind 503, and the
    // failed asks give back the quota they spent.
    mock.mode = 'credit';
    let r = await ask(U, real); ok(r === '503 ask_out_of_credit', `an exhausted credit must 503 ask_out_of_credit: ${r}`);
    mock.mode = 'limit';
    r = await ask(U, real); ok(r === '503 ask_out_of_credit', `a reached workspace spend limit must 503 ask_out_of_credit: ${r}`);
    mock.mode = 'ok';
    const bad = await ask(U); ok(bad === '400 bad_request', `an invalid body must not spend the user quota: ${bad}`);
    const first = await ask(U, real);
    ok(first === '200 undefined', `the first answered ask must get through after two failed ones (refunded): ${first}`);
    const second = await ask(U, real); ok(second === '429 ask_daily_quota', `the second ask past a quota of 1 must 429 ask_daily_quota: ${second}`);
    const other = await ask({ 'X-User-Id': 'subscriber-2' }, real);
    ok(other === '200 undefined', `another subscriber keeps their own quota: ${other}`);

    const report = async (body) => {
      const res = await fetch('http://localhost:3198/api/mn/ask/report', { method: 'POST', headers: { 'Content-Type': 'application/json', ...U }, body: JSON.stringify(body) });
      return res.status;
    };
    ok(await report({ reason: 'wrong' }) === 400, '/ask/report without an answer must 400');
    ok(await report({ reason: 'wrong', question: 'q', answer: 'a' }) === 200, '/ask/report with an answer must 200');
  });
  const files = fs.readdirSync(vol);
  const day = new Date().toISOString().slice(0, 10);
  ok(files.includes(`ask-${day}.jsonl`), `answered asks must be logged to ask-${day}.jsonl: ${files}`);
  ok(files.includes(`ask-reports-${day}.jsonl`), `reports must be saved to ask-reports-${day}.jsonl: ${files}`);
  // A restart keeps the day's counts: subscriber-1 is still out of questions.
  await withServer(SUB, async (ask) => {
    const r = await ask(U, real); ok(r === '429 ask_daily_quota', `the user quota must survive a restart: ${r}`);
  });
  // Logs past 90 days are deleted at start-up.
  const old = path.join(vol, 'ask-2026-01.jsonl');
  fs.writeFileSync(old, '{}\n');
  fs.utimesSync(old, new Date('2026-01-31'), new Date('2026-01-31'));
  const keep = ['feedback.jsonl', 'subscribers.jsonl', 'ask-counts.json'].map(f => path.join(vol, f));
  for (const k of keep) { if (!fs.existsSync(k)) fs.writeFileSync(k, '{}\n'); fs.utimesSync(k, new Date('2026-01-31'), new Date('2026-01-31')); }
  await withServer(SUB, async () => {});
  ok(!fs.existsSync(old), 'a chat log older than 90 days must be pruned at start-up');
  for (const k of keep) ok(fs.existsSync(k), `the prune must leave ${path.basename(k)} alone`);
  fs.rmSync(vol, { recursive: true, force: true });

  // ── 2026-10-27 move-1 fixes ────────────────────────────────────────────────
  const post = async (p, body, headers = {}) => {
    const res = await fetch(`http://localhost:3198${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    let json = null; try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, type, json };
  };
  const msgs = (...turns) => ({ messages: turns.map((c, i) => ({ role: i % 2 ? 'assistant' : 'user', content: c })) });
  const vol2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-unit2-'));
  const SUB2 = { ...SUB, LAKELORE_DB_DIR: vol2, LAKELORE_ASK_USER_DAILY_MAX: '', LAKELORE_ASK_DEADLINE_MS: '2500',
    LAKELORE_ASK_UNLIMITED_USERS: 'owner-phone, owner-tablet' };
  await withServer(SUB2, async () => {
    mock.mode = 'ok'; mock.delayMs = 0;
    // ASK-01: a failed question left in the history (two user turns in a row)
    // is merged, not rejected.
    let r = await post('/api/mn/ask', { messages: [{ role: 'user', content: 'walleye?' }, { role: 'user', content: 'walleye near Brainerd?' }] }, U);
    ok(r.status === 200, `two user turns in a row must be repaired, got ${r.status} ${JSON.stringify(r.json)}`);
    ok(mock.lastBody?.messages?.length === 1 && /walleye\?\n\nwalleye near Brainerd\?/.test(mock.lastBody.messages[0].content), `merged turn not sent as one: ${JSON.stringify(mock.lastBody?.messages)}`);
    // A long earlier answer is shortened, not rejected.
    r = await post('/api/mn/ask', msgs('bass?', 'x'.repeat(2600), 'and pike?'), U);
    ok(r.status === 200, `a 2,600-char earlier answer must be shortened, got ${r.status}`);
    ok(mock.lastBody.messages[1].content.length === 2000, `shortened answer length ${mock.lastBody.messages[1].content.length}`);
    // The 11th question (21 messages) drops the oldest pair instead of failing.
    const long = []; for (let i = 0; i < 21; i++) long.push(i % 2 ? `answer ${i}` : `question ${i}`);
    r = await post('/api/mn/ask', msgs(...long), U);
    ok(r.status === 200 && mock.lastBody.messages.length === 19 && mock.lastBody.messages[0].content === 'question 2', `21-message chat must keep the newest 19: ${r.status} ${mock.lastBody.messages.length}`);
    // Over 12,000 characters in total: oldest pairs go.
    const big = []; for (let i = 0; i < 9; i++) big.push(i % 2 ? 'a'.repeat(1900) : `q${i} ${'b'.repeat(1500)}`);
    r = await post('/api/mn/ask', msgs(...big), U);
    const sent = mock.lastBody.messages.reduce((n, m) => n + m.content.length, 0);
    ok(r.status === 200 && sent <= 12000 && mock.lastBody.messages.at(-1).content.startsWith('q8'), `long chat must be trimmed to 12,000 chars: ${r.status} ${sent}`);
    // What still fails gets a message a person can act on.
    r = await post('/api/mn/ask', msgs('hi', 'hello'), U);
    ok(r.status === 400 && /New chat/.test(r.json?.message || ''), `history ending with the assistant: ${r.status} ${JSON.stringify(r.json)}`);
    r = await post('/api/mn/ask', msgs('q'.repeat(2100)), U);
    ok(r.status === 400 && /too long/.test(r.json?.message || ''), `over-long question: ${r.status} ${JSON.stringify(r.json)}`);
    // ASK-06: the request carries automatic caching for the conversation tail
    // and keeps the 1-hour system breakpoint.
    ok(mock.lastBody?.cache_control?.type === 'ephemeral' && !mock.lastBody.cache_control.ttl, `top-level cache_control missing: ${JSON.stringify(mock.lastBody?.cache_control)}`);
    ok(mock.lastBody?.system?.[0]?.cache_control?.ttl === '1h', 'system prompt lost its 1-hour cache breakpoint');
    // ASK-04: at the deadline the user gets a normal answer telling them to
    // narrow the question, and the question is not counted.
    mock.delayMs = 6000;
    const t0 = Date.now();
    r = await post('/api/mn/ask', msgs('every lake in the state?'), { 'X-User-Id': 'slow-user' });
    ok(r.status === 200 && /narrower question/.test(r.json?.answer || '') && r.json?.usage?.stop_reason === 'deadline', `deadline answer: ${r.status} ${JSON.stringify(r.json)}`);
    ok(Date.now() - t0 < 4500, `deadline did not cut the ask short: ${Date.now() - t0} ms`);
    const counts = JSON.parse(fs.readFileSync(path.join(vol2, 'ask-counts.json'), 'utf8'));
    ok(counts.users['slow-user'] === 1, `a deadline answer is an answer and must count once: ${JSON.stringify(counts.users)}`);
    // A client that hangs up before any model call finished gets the question back.
    mock.delayMs = 3000;
    const ac = new AbortController();
    const gone = fetch('http://localhost:3198/api/mn/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': 'leaver' }, body: JSON.stringify(msgs('pike?')), signal: ac.signal }).catch(() => 'aborted');
    await new Promise(r => setTimeout(r, 300)); ac.abort(); await gone;
    await new Promise(r => setTimeout(r, 300));
    const c2 = JSON.parse(fs.readFileSync(path.join(vol2, 'ask-counts.json'), 'utf8'));
    ok(!c2.users['leaver'], `a client that left before any model call finished must get the question back: ${JSON.stringify(c2.users)}`);
    mock.delayMs = 0;
    // Empty turns and a leading assistant turn are dropped, not rejected.
    r = await post('/api/mn/ask', { messages: [{ role: 'assistant', content: 'Welcome!' }, { role: 'user', content: '  ' }, { role: 'user', content: 'crappie?' }] }, U);
    ok(r.status === 200 && mock.lastBody.messages.length === 1 && mock.lastBody.messages[0].content === 'crappie?', `leading assistant / empty turn repair: ${r.status} ${JSON.stringify(mock.lastBody?.messages)}`);
    mock.delayMs = 0;
    // Default per-subscriber cap is 15; unlimited users are exempt.
    let last = '';
    for (let i = 0; i < 16; i++) last = (await post('/api/mn/ask', msgs('perch?'), { 'X-User-Id': 'capped' })).status;
    ok(last === 429, `16th ask under the default cap of 15 must 429, got ${last}`);
    for (let i = 0; i < 16; i++) last = (await post('/api/mn/ask', msgs('perch?'), { 'X-User-Id': 'owner-tablet' })).status;
    ok(last === 200, `an unlimited user must never hit the daily cap, got ${last}`);
  });
  fs.rmSync(vol2, { recursive: true, force: true });
  // The per-IP hourly limit is off unless set; when set it still works.
  await withServer({ ...SUB, LAKELORE_DB_DIR: '', LAKELORE_ASK_PER_HOUR: '2', LAKELORE_ASK_USER_DAILY_MAX: '' }, async (ask) => {
    const a = [await ask(U, real), await ask(U, real), await ask(U, real)];
    ok(a[0] === '200 undefined' && a[2] === '429 ask_quota', `LAKELORE_ASK_PER_HOUR=2 lever: ${a}`);
  });

  // SRV-02 / SRV-03 / SRV-04 / SEC-02 on a production-mode server.
  await withServer({}, async () => {
    const get = async (p) => { const res = await fetch(`http://localhost:3198${p}`); return { status: res.status, type: res.headers.get('content-type') || '', json: await res.json().catch(() => null) }; };
    let r = await get('/api/mn/nonexistent');
    ok(r.status === 404 && /json/.test(r.type) && r.json?.error === 'not_found', `unknown path must be a JSON 404: ${r.status} ${r.type}`);
    r = await post('/api/feedback', '{bad');
    ok(r.status === 400 && /json/.test(r.type) && r.json?.error === 'invalid_json', `malformed JSON body must be a JSON 400: ${r.status} ${r.type} ${JSON.stringify(r.json)}`);
    r = await post('/api/feedback', { message: 'x'.repeat(17000) });
    ok(r.status === 413 && /json/.test(r.type), `oversized body must be a JSON 413: ${r.status} ${r.type}`);
    r = await post('/api/subscribe', { email: 'a@b.co' });
    ok(r.status === 404 && /json/.test(r.type), `/api/subscribe must be gone: ${r.status}`);
    r = await get('/api/mn/results?offset=9999999999999999999999');
    ok(r.status === 400 && r.json?.error === 'bad_request', `huge offset must 400, got ${r.status} ${JSON.stringify(r.json)}`);
    r = await get('/api/mn/results?offset=100&limit=5');
    ok(r.status === 200, `a normal offset must still work: ${r.status}`);
  });
  const fbVol = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-unit-'));
  await withServer({ FEEDBACK_LOG_PATH: path.join(fbVol, 'feedback.jsonl'), LAKELORE_FEEDBACK_PER_DAY: '3' }, async () => {
    let r = await post('/api/feedback', { message: 'wrong depth', state: 'mn', lakeName: 'L'.repeat(500), species: { $gt: 1 }, build: 35 });
    ok(r.status === 200, `feedback must save: ${r.status}`);
    const saved = JSON.parse(fs.readFileSync(path.join(fbVol, 'feedback.jsonl'), 'utf8').trim());
    ok(saved.lakeName.length === 128 && saved.species === null && saved.build === 35, `feedback fields must be clipped/typed: ${JSON.stringify(saved).slice(0, 200)}`);
    await post('/api/feedback', { message: 'two' }); await post('/api/feedback', { message: 'three' });
    r = await post('/api/feedback', { message: 'four' });
    ok(r.status === 429 && /json/.test(r.type), `feedback past the per-IP daily cap must 429 JSON: ${r.status}`);
  });
  fs.rmSync(fbVol, { recursive: true, force: true });

  // SRV-01: lakes whose stocking rows have no life stage must still send a
  // string, because every shipped app lowercases it.
  {
    const Database = require('better-sqlite3');
    const canonical = require('../server/canonical.js');
    const ld = require(path.join(os.homedir(), 'lakelore-data'));
    const db = new Database(path.join(os.homedir(), 'lakelore-data', 'out', 'tx.db'), { readonly: true });
    const row = db.prepare('SELECT lake_id FROM stocking WHERE life_stage IS NULL LIMIT 1').get();
    ok(!!row, 'tx.db has no NULL life_stage row to test with');
    if (row) {
      const ctx = { getDb: () => db, isUnhealthy: () => false, getStateEntry: s => ld.getState(s), computeLakeStockingMetrics: () => ({}) };
      const r = { statusCode: 200 }; r.status = c => (r.statusCode = c, r); r.json = b => (r.body = b, r); r.set = () => r;
      canonical.lakeDetail({ params: { state: 'tx', id: String(row.lake_id) }, query: {}, get: () => undefined, lakeLorePreview: false }, r, ctx);
      const st = r.body?.stocking || [];
      ok(r.statusCode === 200 && st.length > 0 && st.every(s => typeof s.life_stage === 'string'), `tx lake ${row.lake_id}: ${r.statusCode}, life_stage values ${JSON.stringify([...new Set(st.map(s => s.life_stage))])}`);
    }
    db.close();
  }

  // Gear sources (2026-10-27, GEAR_CONSOLIDATION.md). (1) A trailing
  // parenthetical is a unit only when it reads as a rate — mesh/length
  // qualifiers stay in the name. (2) Gears that sampled the species on fewer
  // than 3 lakes statewide are hidden from the picker, never emptying a
  // measure, and a county filter does not hide a gear that is big statewide.
  {
    const Database = require('better-sqlite3');
    const canonical = require('../server/canonical.js');
    const ld = require(path.join(os.homedir(), 'lakelore-data'));
    const db = new Database(path.join(os.homedir(), 'lakelore-data', 'out', 'nd.db'), { readonly: true });
    const ctx = { getDb: () => db, isUnhealthy: () => false, getStateEntry: s => ld.getState(s), computeLakeStockingMetrics: () => ({}) };
    const call = (query) => {
      const r = { statusCode: 200 }; r.status = c => (r.statusCode = c, r); r.json = b => (r.body = b, r); r.set = () => r;
      canonical.measures({ params: { state: 'nd' }, query, get: () => undefined, lakeLorePreview: false }, r, ctx);
      return r.body;
    };
    const cpueLakes = (sp) => new Map(db.prepare('SELECT gear_category g, COUNT(DISTINCT lake_id) n FROM fish_catch WHERE species_native = ? AND gear_category IS NOT NULL AND cpue_effective IS NOT NULL GROUP BY 1').all(sp).map(r => [r.g, r.n]));
    let hiddenSeen = 0;
    for (const { sp } of db.prepare("SELECT DISTINCT species_native sp FROM fish_catch").all()) {
      const body = call({ species: sp });
      for (const m of body.measures || []) {
        if (!m.requiresSource) continue;
        ok(m.sources.length > 0, `nd ${sp} ${m.id}: measure emptied`);
        ok(m.sources.some(x => x.id === m.defaultSourceId), `nd ${sp} ${m.id}: default source was hidden`);
        if (['abundance', 'size', 'trophy'].includes(m.id)) {
          const tinyShown = m.sources.filter(x => x.gear != null && x.lakes < 3 && x.id !== m.defaultSourceId);
          ok(tinyShown.length === 0, `nd ${sp} ${m.id}: tiny gear shown: ${tinyShown.map(x => x.gear)}`);
        }
      }
      const ab = (body.measures || []).find(m => m.id === 'abundance');
      if (ab) hiddenSeen += [...cpueLakes(sp)].filter(([g, n]) => n < 3 && !ab.sources.some(x => x.gear === g)).length;
    }
    ok(hiddenSeen > 0, 'expected at least one tiny ND gear to be hidden from /measures');
    // /filters gear chips follow the same rule (the app's Gear Type chips read these).
    {
      const r = { statusCode: 200 }; r.status = c => (r.statusCode = c, r); r.json = b => (r.body = b, r); r.set = () => r;
      const all = new Map(db.prepare("SELECT gear_category g, COUNT(DISTINCT lake_id) n FROM fish_catch WHERE species_native='BLG' AND gear_category IS NOT NULL GROUP BY 1").all().map(x => [x.g, x.n]));
      canonical.filters({ params: { state: 'nd' }, query: { species: 'BLG' }, get: () => undefined, lakeLorePreview: false }, r, ctx);
      const chips = r.body.gearTypes || [];
      const tiny = [...all].filter(([, n]) => n < 3).map(([g]) => g);
      ok(chips.length > 0 && chips.every(g => (all.get(g) ?? 0) >= 3 || g === r.body.defaultGear), `nd BLG chips include a tiny gear: ${JSON.stringify(chips)}`);
      ok(tiny.length === 0 || tiny.every(g => !chips.includes(g)) , `nd BLG tiny chips still listed: ${tiny}`);
      ok(Object.keys(r.body.gearTypeCounts || {}).every(g => chips.includes(g)), 'gearTypeCounts lists a hidden chip');
    }
    const wae = call({ species: 'WAE' }).measures.find(m => m.id === 'abundance');
    const gill = wae.sources.find(x => x.gear === 'Gill net (#/net-night, 80-ft standard)');
    ok(gill && gill.label === 'Gill net' && gill.unit === '#/net-night, 80-ft standard' && gill.lakes > 270, `nd walleye gill net source: ${JSON.stringify(gill && { label: gill.label, unit: gill.unit, lakes: gill.lakes })}`);
    // County scope: pick a county where the frame net 3X4 (9 lakes statewide) has <3 lakes for WAE; it must still show there.
    const c = db.prepare(`SELECT l.county c FROM fish_catch fc JOIN lakes l ON l.id = fc.lake_id WHERE fc.species_native='WAE' AND fc.gear_category = '3 X 4 w/ 1/4" Mesh' AND fc.cpue_effective IS NOT NULL GROUP BY 1 HAVING COUNT(DISTINCT fc.lake_id) < 3 LIMIT 1`).get();
    if (c) {
      const cm = call({ species: 'WAE', county: c.c }).measures.find(m => m.id === 'abundance');
      ok(cm.sources.some(x => x.gear === '3 X 4 w/ 1/4" Mesh'), `county ${c.c}: statewide-big frame net hidden by county scope`);
    }
    db.close();
  }

  // Default gear (2026-10-27): most lakes surveyed in the last 10 years, not
  // most rows ever; electrofishing first for bass/bluegill when it covers 60%
  // of the leader; /filters always states the default for older clients.
  {
    const Database = require('better-sqlite3');
    const canonical = require('../server/canonical.js');
    const ld = require(path.join(os.homedir(), 'lakelore-data'));
    const check = (st, species, want) => {
      const db = new Database(path.join(os.homedir(), 'lakelore-data', 'out', `${st}.db`), { readonly: true });
      const ctx = { getDb: () => db, isUnhealthy: () => false, getStateEntry: s => ld.getState(s), computeLakeStockingMetrics: () => ({}) };
      const run = (fn) => { const r = { statusCode: 200 }; r.status = c => (r.statusCode = c, r); r.json = b => (r.body = b, r); r.set = () => r;
        canonical[fn]({ params: { state: st }, query: { species }, get: () => undefined, lakeLorePreview: false }, r, ctx); return r.body; };
      const ab = run('measures').measures.find(m => m.id === 'abundance');
      const def = ab.sources.find(x => x.id === ab.defaultSourceId);
      ok(def && want.test(def.gear || ''), `${st} ${species}: abundance default ${def && def.gear}, want ${want}`);
      const f = run('filters');
      ok(want.test(f.defaultGear || ''), `${st} ${species}: /filters defaultGear ${f.defaultGear}, want ${want}`);
      db.close();
    };
    check('sd', 'Walleye', /^AFS standard gill net/);          // was the series that ended in 2017
    check('sd', 'Largemouth Bass', /^Night boat electrofishing/); // was a pre-2015 historical trap net
    check('mn', 'LMB', /^Standard electrofishing$/);            // rule 2 (was trap nets, 0.8 bass/net)
    check('mn', 'WAE', /^Standard gill nets$/);                 // unchanged
    check('wi', 'WAE', /^Fyke net/);                            // unchanged
    check('nd', 'WAE', /^Gill net/);                            // unchanged
  }

  // Switched off (no LAKELORE_ASK_ENABLED): client-config tells 1.1.2+ apps
  // to hide the chat.
  await withServer({ LAKELORE_ASK_ENABLED: '' }, async () => {
    const cfg = await (await fetch('http://localhost:3198/api/client-config')).json();
    ok(cfg.ask && cfg.ask.enabled === false, `client-config must report ask.enabled:false when switched off: ${JSON.stringify(cfg.ask)}`);
  });
  model.close();

  if (failures) { console.error(`\nUNIT FAILED — ${failures} failure(s)`); process.exit(1); }
  console.log('UNIT OK — RevenueCat deadline, /ask gate');
  process.exit(0);
})().catch(err => { console.error('unit test crashed:', err); process.exit(1); });
