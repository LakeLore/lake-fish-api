'use strict';

// Handled failures: a route that catches an error and answers 5xx itself never
// reaches Sentry's Express error handler (that only sees errors passed to
// next()), so before this helper every caught 500 was visible only in Fly's
// log buffer, which keeps nothing. No-ops when Sentry was never initialized.
const Sentry = require('@sentry/node');

function reportError(err, req, extra) {
  try {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: {
        handled: 'true',
        route: req?.route?.path || 'unknown',
        state: req?.params?.state || 'none',
        ...extra,
      },
    });
  } catch { /* reporting must never turn a 500 into a crash */ }
}

// Answer a caught 5xx (2026-10-27, SRV-03). SQLite's own message (it can name
// the DB path or echo the bad value) never goes to the client, and the two
// error kinds a bad query string can cause (a datatype mismatch or an
// out-of-range bind) are not sent to Sentry — before this, one request
// repeated a few hundred times could use up the month's Sentry quota.
const SQLITE_INPUT_ERRORS = new Set(['SQLITE_MISMATCH', 'SQLITE_RANGE']);
function serverError(res, err, req) {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (!SQLITE_INPUT_ERRORS.has(code)) reportError(err, req);
  if (code.startsWith('SQLITE_')) return res.status(500).json({ error: 'query_failed' });
  return res.status(500).json({ error: err?.message || 'internal_error' });
}

// Sentry beforeSend guard: at most SENTRY_MAX_EVENTS events per 10 minutes per
// machine (default 20). The free plan's monthly quota is 5,000; a crash loop
// or a scripted bad request would otherwise use it up in hours and leave the
// rest of the month with no crash reports. Dropped events are counted in the
// log so a burst is still visible.
const SENTRY_WINDOW_MS = 10 * 60 * 1000;
let _sentryWindowStart = 0, _sentrySent = 0, _sentryDropped = 0;
function sentryBeforeSend(event) {
  const max = Number(process.env.SENTRY_MAX_EVENTS) > 0 ? Number(process.env.SENTRY_MAX_EVENTS) : 20;
  const now = Date.now();
  if (now - _sentryWindowStart > SENTRY_WINDOW_MS) {
    if (_sentryDropped) console.warn(`[sentry] dropped ${_sentryDropped} event(s) over the ${max}/10 min cap`);
    _sentryWindowStart = now; _sentrySent = 0; _sentryDropped = 0;
  }
  if (_sentrySent >= max) { _sentryDropped++; return null; }
  _sentrySent++;
  return event;
}

module.exports = { reportError, serverError, sentryBeforeSend };
