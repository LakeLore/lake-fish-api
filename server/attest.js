// Platform attestation at the /api/session gate (IMPROVEMENT_PLAN 1.8, final
// hardening step): App Attest (iOS) / Play Integrity (Android) proof that the
// caller is the genuine LakeLore binary on real hardware, verified server-side
// before a session token is minted. Everything here is OPTIONAL input — a
// session request without attestation still succeeds (att:'none' claim) until
// the LAKELORE_REQUIRE_ATTEST=1 flip (drain-gated on the [attest] telemetry,
// same playbook as the sig/token flips — ~/RUNBOOK.md §16).
//
// Flow (client side is src/attest.ts in the mobile repo):
//   1. GET /api/session/challenge → single-purpose stateless nonce bound to
//      the caller's userId (HMAC-signed, 10-min TTL — no shared state, so it
//      works across BOTH Fly machines without sticky routing).
//   2. iOS: DCAppAttestService generates a fresh key + attestation over
//      SHA256(challenge); we verify the full Apple cert chain + nonce with
//      appattest-checker-node. A fresh key per session keeps signCount at 0
//      (the checker requires it) and sidesteps re-attestation rate limits.
//   3. Android: Play Integrity standard request with requestHash=challenge;
//      we decode via playintegrity.googleapis.com using the existing Play
//      service account and check verdicts + requestHash + package name.
//
// Android is DORMANT until two console-side steps are done (documented in
// ~/APP_OPS.md): link Cloud project `lakelore-play` in Play Console → App
// integrity, and enable playintegrity.googleapis.com on that project. Until
// then verifyAndroid returns {ok:false, reason:'not_configured'} and shows up
// in telemetry as android_unavailable — never a hard failure.

'use strict';

const crypto = require('crypto');

const APPLE_APP_ID = process.env.LAKELORE_APPATTEST_APP_ID || '2SXGANA52C.com.lakeloreapp.lakelore';
// Production entitlement covers TestFlight + App Store builds. Dev-signed
// builds attest against the development AAGUID and will fail verification
// here unless this is set — acceptable, dev clients skip attestation anyway.
const APPLE_DEV_ENV = process.env.LAKELORE_APPATTEST_DEV === '1';
const ANDROID_PACKAGE = 'com.lakeloreapp.lakelore';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

// Challenge HMAC key is derived from the JWT secret so both machines agree
// without another Fly secret to rotate.
const challengeKey = () =>
  crypto.createHmac('sha256', process.env.LAKELORE_JWT_SECRET || 'lakelore-dev-jwt-secret')
    .update('challenge-v1').digest();

// Telemetry for the enforcement flip (mirrors _sigStats in server.js): the
// flip is safe when `none` is ~0 over a sustained window. Live totals ride
// /healthz?deep=1 as `attest`; hourly summary log below.
const stats = {
  ios_ok: 0, ios_fail: 0,
  android_ok: 0, android_fail: 0, android_unavailable: 0,
  none: 0, bad_challenge: 0,
  since: Date.now(),
};
function logAndResetStats() {
  const mins = Math.round((Date.now() - stats.since) / 60000);
  console.log(`[attest] last ${mins}m: ios_ok=${stats.ios_ok} ios_fail=${stats.ios_fail}`
    + ` android_ok=${stats.android_ok} android_fail=${stats.android_fail}`
    + ` android_unavailable=${stats.android_unavailable} none=${stats.none} bad_challenge=${stats.bad_challenge}`
    + (stats.none === 0 && (stats.ios_ok + stats.android_ok) > 0
      ? ' — unattested traffic drained; LAKELORE_REQUIRE_ATTEST=1 is safe if this holds' : ''));
  for (const k of Object.keys(stats)) if (k !== 'since') stats[k] = 0;
  stats.since = Date.now();
}

// ── Stateless challenge ─────────────────────────────────────────────────────
// v1.<ts>.<nonce>.<sig> — sig binds userId+ts+nonce, so a challenge minted on
// machine A verifies on machine B, and a captured challenge is only usable
// with the same userId it was issued to. Single-use isn't enforced (no shared
// store); the 10-min TTL plus the userId binding bounds replay to "re-issuing
// a token the caller could get anyway".
function makeChallenge(userId) {
  const ts = Date.now().toString(36);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const sig = crypto.createHmac('sha256', challengeKey())
    .update(`${userId}.${ts}.${nonce}`).digest('base64url').slice(0, 22);
  return `v1.${ts}.${nonce}.${sig}`;
}

function checkChallenge(userId, challenge) {
  if (typeof challenge !== 'string' || challenge.length > 200) return false;
  const parts = challenge.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const [, ts, nonce, sig] = parts;
  const expect = crypto.createHmac('sha256', challengeKey())
    .update(`${userId}.${ts}.${nonce}`).digest('base64url').slice(0, 22);
  const a = Buffer.from(sig); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const issued = parseInt(ts, 36);
  return Number.isFinite(issued) && Date.now() - issued < CHALLENGE_TTL_MS;
}

// ── iOS: App Attest ─────────────────────────────────────────────────────────
// Client (pagopa io-react-native-integrity) computes clientDataHash =
// SHA256(utf8(challenge)) and base64-encodes the CBOR attestation;
// appattest-checker-node hashes the challenge Buffer the same way, so the
// nonces line up (both verified against source, 2026-07-16).
async function verifyIos({ keyId, attestation, challenge }) {
  if (typeof keyId !== 'string' || typeof attestation !== 'string'
    || keyId.length > 100 || attestation.length > 100_000) {
    return { ok: false, reason: 'bad_input' };
  }
  let checker;
  try { checker = require('appattest-checker-node'); }
  catch { return { ok: false, reason: 'checker_missing' }; }
  try {
    const result = await checker.verifyAttestation(
      { appId: APPLE_APP_ID, developmentEnv: APPLE_DEV_ENV },
      keyId,
      Buffer.from(challenge, 'utf8'),
      Buffer.from(attestation, 'base64'),
    );
    if (result.verifyError) return { ok: false, reason: result.verifyError };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `exception:${err.message}` };
  }
}

// ── Android: Play Integrity (standard request) ──────────────────────────────
// Decode requires an OAuth token for the Play service account with the
// playintegrity scope. No googleapis dependency — the SA JWT grant is ~20
// lines of crypto.

function loadServiceAccount() {
  try {
    if (process.env.PLAY_INTEGRITY_SA_JSON) return JSON.parse(process.env.PLAY_INTEGRITY_SA_JSON);
    if (process.env.PLAY_INTEGRITY_SA_FILE) {
      return JSON.parse(require('fs').readFileSync(process.env.PLAY_INTEGRITY_SA_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn(`[attest] service-account load failed: ${err.message}`);
  }
  return null;
}

let _gToken = null; // { token, exp }
async function googleAccessToken() {
  if (_gToken && _gToken.exp - Date.now() > 60_000) return _gToken.token;
  const sa = loadServiceAccount();
  if (!sa) return null;
  const now = Math.floor(Date.now() / 1000);
  const b64u = (s) => Buffer.from(s).toString('base64url');
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/playintegrity',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${sig}`,
    }),
  });
  if (!res.ok) {
    console.warn(`[attest] google token exchange failed: ${res.status}`);
    return null;
  }
  const body = await res.json();
  _gToken = { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return _gToken.token;
}

async function verifyAndroid({ token, challenge }) {
  if (typeof token !== 'string' || token.length > 100_000) return { ok: false, reason: 'bad_input' };
  const access = await googleAccessToken().catch(() => null);
  if (!access) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetch(
      `https://playintegrity.googleapis.com/v1/${ANDROID_PACKAGE}:decodeIntegrityToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
        body: JSON.stringify({ integrityToken: token }),
      },
    );
    if (!res.ok) {
      // 403 here usually means the Cloud project isn't linked in Play Console
      // yet or the API isn't enabled — the documented console-side steps.
      const detail = await res.text().catch(() => '');
      console.warn(`[attest] decodeIntegrityToken ${res.status}: ${detail.slice(0, 200)}`);
      return { ok: false, reason: res.status === 403 ? 'not_configured' : `decode_${res.status}` };
    }
    const payload = (await res.json())?.tokenPayloadExternal;
    if (!payload) return { ok: false, reason: 'empty_payload' };
    const reqd = payload.requestDetails ?? {};
    // Standard requests carry requestHash; classic requests carry nonce.
    const echoed = reqd.requestHash ?? reqd.nonce;
    if (echoed !== challenge) return { ok: false, reason: 'challenge_mismatch' };
    if (reqd.requestPackageName && reqd.requestPackageName !== ANDROID_PACKAGE) {
      return { ok: false, reason: 'package_mismatch' };
    }
    if (payload.appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
      return { ok: false, reason: `app_${payload.appIntegrity?.appRecognitionVerdict ?? 'unknown'}` };
    }
    const device = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    if (!device.includes('MEETS_DEVICE_INTEGRITY')) {
      return { ok: false, reason: 'device_integrity' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `exception:${err.message}` };
  }
}

module.exports = { makeChallenge, checkChallenge, verifyIos, verifyAndroid, stats, logAndResetStats };
