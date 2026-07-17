'use strict';

// entitlement.js — server-side entitlement gating for the LakeLore
// All-States subscription. Hits RevenueCat's REST API to look up a user's
// current entitlement, caches the result for 5 minutes per user, and
// invalidates on RC webhook events.
//
// Free tier: MN. Everything else requires the entitlement identifier
// `LakeLore All-States` (matches the value configured in the RC dashboard).
//
// Behavior when REVENUECAT_SECRET_KEY is unset:
//   - In development: fail-open (allow paid states), log a loud warning
//     once per process. Useful so local dev keeps working before the
//     secret is configured.
//   - In production: fail-closed (return 402). The server will still
//     boot, but every paid-state request will be denied. Caller must
//     set the Fly secret to enable paid access.

const ALL_STATES_ENTITLEMENT = 'LakeLore All-States';
// Free tier derives from registry `free: true` flags — same source of truth
// as the app's generated config. Falls back to the launch literal only if
// the registry is unreadable (server.js exits at startup in that case anyway).
const FREE_STATES = (() => {
  try {
    const { loadRegistry } = require('../lakelore-data');
    const reg = loadRegistry();
    const free = Object.keys(reg.states).filter(s => reg.states[s].free === true);
    if (!free.length) throw new Error('registry lists no free states');
    return new Set(free);
  } catch (err) {
    console.error(`[entitlement] registry unavailable for FREE_STATES — defaulting to mn: ${err.message}`);
    return new Set(['mn']);
  }
})();
const CACHE_TTL_MS = 5 * 60 * 1000;
const RC_API_BASE = 'https://api.revenuecat.com/v2';

// Match only the *data-bearing* endpoints. /status and /filters are public
// metadata (lake counts, species lists, county lists) — they're shown on
// the marketing site at lakeloreapp.com and inform the user before they
// decide to subscribe, so they stay free for all states.
//
// Gated endpoints:
//   /api/{state}/results      — PREVIEW for non-subscribers: passes through
//                               with req.lakeLorePreview=true; the handler
//                               returns all metrics but redacts lake identity
//                               (name, county, acres, coords — see
//                               server/canonical.js). Never 402s.
//   /api/{state}/lake/:id     — PREVIEW for non-subscribers too (2026-07-15):
//                               full CPUE/stocking detail with the same
//                               identity fields redacted, plus report ids and
//                               source-PDF links withheld. Never 402s.
//   /api/{state}/pdf/:name    — Nebraska survey PDFs (NE-specific) — hard 402
//                               (the PDF itself names the lake).
//
// Only ACTIVE states appear here — the set is whatever the registry flags
// `active: true`, so it tracks launches without edits here. States flagged
// `active: false` (the no-metric holdbacks — az/de/ma/qc/ri/sc as of 2026-07)
// fall through to route validation, which returns 400 (not 402). That keeps
// the client's SubscriptionRequiredError → paywall flow from firing on states
// the user can't reach in the first place.
//
// The state list is generated from lakelore-data/registry/states.json (all
// `active` states — including free MN, which matches and then passes through
// inside gateByState via FREE_STATES). When the registry is unavailable
// (e.g. Docker image without lakelore-data), we fall back to the legacy
// 5-state literal so the original launch states are never served ungated.
const LEGACY_GATED_SOURCE = '^\\/api\\/(mn|sd|nd|ia|ne)\\/(results|lake|pdf)(?:\\/|\\?|$)';
const GATED_PATH_RE = (() => {
  const fallback = new RegExp(LEGACY_GATED_SOURCE);
  try {
    const { loadRegistry } = require('../lakelore-data');
    const reg = loadRegistry();
    const active = Object.keys(reg.states).filter(s => reg.states[s].active === true);
    if (!active.length) throw new Error('registry lists no active states');
    const generated = `^\\/api\\/(${active.join('|')})\\/(results|lake|pdf)(?:\\/|\\?|$)`;
    console.log(`[entitlement] gate covers ${active.length} active states (registry-generated)`);
    return new RegExp(generated);
  } catch (err) {
    console.error(`[entitlement] registry unavailable — using legacy gated-path literal: ${err.message}`);
    return fallback;
  }
})();

const _cache = new Map();
let _warnedNoKey = false;

// Lazy cache of the internal RC entitlement ID (entl_xxx) corresponding to
// our human-friendly ALL_STATES_ENTITLEMENT lookup_key. RC's v2
// `/customers/{id}/active_entitlements` endpoint returns objects with only
// `entitlement_id` — `lookup_key` is NOT included — so we resolve the lookup
// key to the internal ID once at startup and match against it on every
// per-user request thereafter.
//
// If the entitlement is ever deleted + recreated in the RC dashboard, the
// internal ID changes; restart the server to pick up the new mapping (or
// call `_resetAllStatesEntitlementId()` from a test).
let _allStatesEntitlementIdPromise = null;

function _resetAllStatesEntitlementId() {
  _allStatesEntitlementIdPromise = null;
}

async function _resolveAllStatesEntitlementId() {
  if (_allStatesEntitlementIdPromise) return _allStatesEntitlementIdPromise;
  const key = process.env.REVENUECAT_SECRET_KEY;
  const projectId = process.env.REVENUECAT_PROJECT_ID;
  if (!key || !projectId) return null;
  _allStatesEntitlementIdPromise = (async () => {
    try {
      const url = `${RC_API_BASE}/projects/${projectId}/entitlements?limit=100`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`RC entitlements list HTTP ${res.status}`);
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      const match = items.find(e => e?.lookup_key === ALL_STATES_ENTITLEMENT);
      if (!match?.id) {
        console.warn(
          `[entitlement] no entitlement found in RC with lookup_key=${ALL_STATES_ENTITLEMENT}`
        );
        return null;
      }
      console.log(
        `[entitlement] resolved lookup_key=${ALL_STATES_ENTITLEMENT} -> ${match.id}`
      );
      return match.id;
    } catch (err) {
      console.warn(`[entitlement] failed to resolve all-states entitlement id: ${err.message}`);
      // Surface the failure so the next call retries instead of caching null.
      _allStatesEntitlementIdPromise = null;
      return null;
    }
  })();
  return _allStatesEntitlementIdPromise;
}

function isPaidState(state) {
  return !FREE_STATES.has(state);
}

async function fetchEntitlementFromRevenueCat(userId) {
  const key = process.env.REVENUECAT_SECRET_KEY;
  const projectId = process.env.REVENUECAT_PROJECT_ID;
  if (!key || !projectId) {
    if (!_warnedNoKey) {
      const failOpen = process.env.NODE_ENV !== 'production';
      console.warn(
        `[entitlement] REVENUECAT_SECRET_KEY or REVENUECAT_PROJECT_ID not set — `
        + (failOpen ? 'fail-OPEN (development)' : 'fail-CLOSED (production)')
      );
      _warnedNoKey = true;
    }
    return {
      hasAllStates: process.env.NODE_ENV !== 'production',
      expiresAt: null,
      source: 'no-key',
    };
  }

  try {
    // RC v2 returns active_entitlements objects with only `entitlement_id`
    // (internal `entl_xxx`) — no `lookup_key`. Resolve the lookup_key to the
    // internal ID up front, then match on that.
    const targetId = await _resolveAllStatesEntitlementId();
    const url = `${RC_API_BASE}/projects/${projectId}/customers/${encodeURIComponent(userId)}/active_entitlements`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 404) {
      // RC returns 404 for users it has never seen — they haven't subscribed.
      return { hasAllStates: false, expiresAt: null, source: 'rc-404' };
    }
    if (!res.ok) {
      throw new Error(`RC HTTP ${res.status}`);
    }
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    // Primary match path: by resolved internal entitlement id. Fallback path
    // matches on `lookup_key` in case RC ever populates it on this endpoint
    // — keeps the code resilient to a future API shape change.
    const ent = items.find(e =>
      (targetId && e?.entitlement_id === targetId)
      || e?.lookup_key === ALL_STATES_ENTITLEMENT
    );
    if (!ent) {
      return { hasAllStates: false, expiresAt: null, source: 'rc' };
    }
    // RC's "active_entitlements" endpoint already filters out expired ones,
    // so any entry here is currently active. expires_at is a Unix-ms epoch
    // when present (null = lifetime / non-expiring).
    const expiresAt = typeof ent.expires_at === 'number' ? ent.expires_at : null;
    const expiresIso = expiresAt ? new Date(expiresAt).toISOString() : null;
    return { hasAllStates: true, expiresAt: expiresIso, source: 'rc' };
  } catch (err) {
    console.warn(`[entitlement] RC fetch failed for ${userId}: ${err.message}`);
    // Upstream blip — don't lock paying customers out for it. Cached
    // briefly with `error` flag so the next request retries.
    return {
      hasAllStates: false,
      expiresAt: null,
      source: 'rc-error',
      error: err.message,
    };
  }
}

// Grace window for KNOWN subscribers when RevenueCat is unreachable
// (IMPROVEMENT_PLAN 1.9): an RC outage must not lock paying customers out of
// lake detail/PDFs. We keep the last POSITIVE entitlement per user in
// _lastGood and serve it for up to GRACE_MS when a fresh lookup ERRORS
// (network/5xx). A positive RC "not subscribed" answer still wins — grace
// only bridges outages, it never overrides a real denial.
const GRACE_MS = 72 * 60 * 60 * 1000;
const _lastGood = new Map(); // userId -> { expiresAt, seenAt }

// The grace map must survive restarts — a deploy/failover DURING an RC outage
// is exactly when it's needed. Write-through to the data volume (per-machine;
// each machine bridges outages for the users it has served).
const fs = require('fs');
const path = require('path');
const GRACE_PATH = process.env.LAKELORE_GRACE_PATH
  || (process.env.LAKELORE_DB_DIR
    ? path.join(process.env.LAKELORE_DB_DIR, 'entitlement-lastgood.json')
    : path.join(__dirname, '.entitlement-lastgood.json'));

(function loadLastGood() {
  try {
    const raw = JSON.parse(fs.readFileSync(GRACE_PATH, 'utf8'));
    const now = Date.now();
    let n = 0;
    for (const [userId, rec] of Object.entries(raw)) {
      if (rec && typeof rec.seenAt === 'number' && (now - rec.seenAt) < GRACE_MS) {
        _lastGood.set(userId, rec);
        n++;
      }
    }
    if (n) console.log(`[entitlement] loaded ${n} grace records from ${GRACE_PATH}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[entitlement] could not load grace records: ${err.message}`);
  }
})();

let _saveTimer = null;
function saveLastGoodSoon() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const now = Date.now();
      const out = {};
      for (const [userId, rec] of _lastGood.entries()) {
        if ((now - rec.seenAt) < GRACE_MS) out[userId] = rec;
      }
      const tmp = `${GRACE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, GRACE_PATH);
    } catch (err) {
      console.warn(`[entitlement] could not persist grace records: ${err.message}`);
    }
  }, 5000);
  _saveTimer.unref?.();
}

// Hourly RC-error-rate telemetry: individual failures already warn per
// request, but a sustained outage should be visible as one summarizable
// signal in the logs.
let _rcErrorCount = 0;
setInterval(() => {
  if (_rcErrorCount > 0) {
    console.warn(`[rc] ${_rcErrorCount} RevenueCat lookup errors in the last hour`);
    _rcErrorCount = 0;
  }
}, 60 * 60 * 1000).unref?.();

async function checkEntitlement(userId) {
  if (!userId) return { hasAllStates: false, expiresAt: null, source: 'no-user-id' };

  const cached = _cache.get(userId);
  const now = Date.now();
  // Honor the per-entry TTL: error results are cached briefly (30 s) so an
  // RC blip doesn't pin `hasAllStates:false` for the full 5 minutes.
  if (cached && (now - cached.fetchedAt) < (cached._ttl ?? CACHE_TTL_MS)) {
    return {
      hasAllStates: cached.hasAllStates,
      expiresAt: cached.expiresAt,
      source: 'cache',
    };
  }

  const result = await fetchEntitlementFromRevenueCat(userId);
  if (result.hasAllStates) {
    _lastGood.set(userId, { expiresAt: result.expiresAt, seenAt: now });
    saveLastGoodSoon();
  } else if (!result.error) {
    // RC positively says not subscribed — clear any stale grace record.
    if (_lastGood.delete(userId)) saveLastGoodSoon();
  } else {
    _rcErrorCount++;
    // RC errored. Serve the last-known-good entitlement inside the grace
    // window instead of 402ing a paying customer during an outage.
    const good = _lastGood.get(userId);
    if (good && (now - good.seenAt) < GRACE_MS) {
      console.warn(`[entitlement] RC error for known subscriber ${userId.slice(0, 8)}… — serving grace entitlement`);
      const grace = { hasAllStates: true, expiresAt: good.expiresAt, source: 'grace' };
      _cache.set(userId, { ...grace, fetchedAt: now, _ttl: 30_000 });
      return grace;
    }
  }
  // Cache successful lookups for the full TTL; cache errors briefly so
  // we don't hammer RC during a sustained outage.
  const ttl = result.error ? 30_000 : CACHE_TTL_MS;
  _cache.set(userId, { ...result, fetchedAt: now, _ttl: ttl });
  return result;
}

function invalidateCache(userId) {
  if (!userId) {
    _cache.clear();
  } else {
    _cache.delete(userId);
  }
}

/**
 * Express middleware. Apply once near the top of the stack (after rate
 * limiting, before routes). Gates `/api/{paid-state}/*` requests on the
 * `LakeLore All-States` entitlement; lets MN, /api/me/*, and /healthz
 * through without checks. POST `/api/{state}/reload` is allowed because
 * it's already protected by `requireReloadToken`.
 *
 * Paid-state /results is NOT denied for non-subscribers — it passes through
 * with `req.lakeLorePreview = true`, and the canonical handlers redact lake
 * identity server-side. This powers the in-app preview: free users can search,
 * filter, see every metric, and open full lake detail (CPUE history, stocking)
 * in paid states — but can't identify the lakes (name, county, acres, coords,
 * and report/PDF links are all withheld). Only /pdf remains hard-gated: the
 * document itself names the lake.
 */
function gateByState(req, res, next) {
  const m = req.path.match(GATED_PATH_RE);
  if (!m) return next();
  const state = m[1];
  const endpoint = m[2]; // 'results' | 'lake' | 'pdf'
  if (!isPaidState(state)) return next();

  const userId = req.get('x-user-id');
  if (!userId) {
    if (endpoint === 'results' || endpoint === 'lake') {
      req.lakeLorePreview = true;
      return next();
    }
    return res.status(402).json({
      error: 'subscription_required',
      state,
      message: `Request to /${state}/* requires the LakeLore All-States subscription. Send X-User-Id header.`,
    });
  }

  checkEntitlement(userId).then(result => {
    if (result.hasAllStates) {
      req.entitlement = result;
      return next();
    }
    if (endpoint === 'results' || endpoint === 'lake') {
      req.lakeLorePreview = true;
      return next();
    }
    res.status(402).json({
      error: 'subscription_required',
      state,
      expiresAt: result.expiresAt,
    });
  }).catch(err => {
    console.warn('[entitlement] middleware error:', err);
    res.status(500).json({ error: 'entitlement_check_failed' });
  });
}

module.exports = {
  ALL_STATES_ENTITLEMENT,
  FREE_STATES,
  isPaidState,
  checkEntitlement,
  invalidateCache,
  gateByState,
  _resetAllStatesEntitlementId,
};
