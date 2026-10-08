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

module.exports = { reportError };
