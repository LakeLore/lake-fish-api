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
//   /api/{state}/results      — search results (the actual data)
//   /api/{state}/lake/:id     — lake detail page (catches, stocking)
//   /api/{state}/pdf/:name    — Nebraska survey PDFs (NE-specific)
const GATED_PATH_RE = /^\/api\/(mn|sd|nd|ia|ne|wi|mi)\/(results|lake|pdf)(?:\/|\?|$)/;

const _cache = new Map();
let _warnedNoKey = false;

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
    // RC v2 API: list a customer's active entitlements. The endpoint returns
    // a paginated list of entitlement objects keyed by `lookup_key`. We match
    // on lookup_key (the human-friendly identifier) rather than the internal
    // `id` (entl_xxx) so the code stays portable across RC projects.
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
    const ent = items.find(e => e?.lookup_key === ALL_STATES_ENTITLEMENT);
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
 */
function gateByState(req, res, next) {
  const m = req.path.match(GATED_PATH_RE);
  if (!m) return next();
  const state = m[1];
  if (!isPaidState(state)) return next();

  const userId = req.get('x-user-id');
  if (!userId) {
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
};
