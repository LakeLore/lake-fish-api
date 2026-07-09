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
const FREE_STATES = new Set(['mn']);
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
//                               returns all metrics but redacts lake names
//                               (see server/canonical.js). Never 402s.
//   /api/{state}/lake/:id     — lake detail page (catches, stocking) — hard 402
//   /api/{state}/pdf/:name    — Nebraska survey PDFs (NE-specific) — hard 402
//
// Only ACTIVE states appear here. Inactive states (wi, mi for v1) fall through
// to route validation, which returns 400 (not 402). That keeps the client's
// SubscriptionRequiredError → paywall flow from firing on states the user can't
// reach in the first place.
//
// The state list is generated from lakelore-data/registry/states.json (all
// `active` states — including free MN, which matches and then passes through
// inside gateByState via FREE_STATES, exactly like the historical literal).
// When the registry is unavailable (e.g. Docker image without lakelore-data),
// we fall back to the legacy literal. A startup assertion cross-checks the
// generated source against the literal and logs loudly on drift — it never
// crashes the server.
const LEGACY_GATED_SOURCE = '^\\/api\\/(mn|sd|nd|ia|ne)\\/(results|lake|pdf)(?:\\/|\\?|$)';
const GATED_PATH_RE = (() => {
  const fallback = new RegExp(LEGACY_GATED_SOURCE);
  try {
    const { loadRegistry } = require('../lakelore-data');
    const reg = loadRegistry();
    const active = Object.keys(reg.states).filter(s => reg.states[s].active === true);
    if (!active.length) throw new Error('registry lists no active states');
    const generated = `^\\/api\\/(${active.join('|')})\\/(results|lake|pdf)(?:\\/|\\?|$)`;
    if (generated !== LEGACY_GATED_SOURCE) {
      console.error(
        '[entitlement] registry-generated gate regex DIFFERS from the legacy literal — '
        + `verify registry active flags are intentional.\n  generated: ${generated}\n  legacy:    ${LEGACY_GATED_SOURCE}`
      );
    }
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

async function checkEntitlement(userId) {
  if (!userId) return { hasAllStates: false, expiresAt: null, source: 'no-user-id' };

  const cached = _cache.get(userId);
  const now = Date.now();
  if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
    return {
      hasAllStates: cached.hasAllStates,
      expiresAt: cached.expiresAt,
      source: 'cache',
    };
  }

  const result = await fetchEntitlementFromRevenueCat(userId);
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
 * with `req.lakeLorePreview = true`, and the results handler redacts lake
 * names server-side. This powers the in-app preview: free users can search,
 * filter, and see every metric in paid states, but can't identify the lakes.
 * /lake/:id and /pdf remain hard-gated — they're the identifiable payoff.
 */
function gateByState(req, res, next) {
  const m = req.path.match(GATED_PATH_RE);
  if (!m) return next();
  const state = m[1];
  const endpoint = m[2]; // 'results' | 'lake' | 'pdf'
  if (!isPaidState(state)) return next();

  const userId = req.get('x-user-id');
  if (!userId) {
    if (endpoint === 'results') {
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
    if (endpoint === 'results') {
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
