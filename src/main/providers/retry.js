'use strict';

// Bounded retry with backoff for provider HTTP calls. Only errors explicitly
// marked retryable (rate limits, overload, transient 5xx, pre-stream connect
// failures) are retried — and connectors only mark errors that occur BEFORE any
// tokens streamed, so a retry can never duplicate partial output.

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

/** Build an HTTP error carrying status metadata so withRetry can classify it. */
function httpError(status, detail, retryAfterHeader) {
  const err = new Error(`HTTP ${status}${detail ? ': ' + detail : ''}`);
  err.status = status;
  err.retryable = RETRYABLE_STATUS.has(status);
  const ra = Number(retryAfterHeader);
  if (Number.isFinite(ra) && ra >= 0) err.retryAfterMs = Math.min(ra * 1000, 60000);
  return err;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * Run fn with up to `retries` retries on err.retryable. Waits the server's
 * Retry-After when given, else 1s/2s/4s with jitter. An abort (user STOP)
 * always wins over a pending retry.
 */
async function withRetry(fn, { retries = 3, signal, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (!err || !err.retryable || attempt >= retries || (signal && signal.aborted)) throw err;
      const delay = err.retryAfterMs != null ? err.retryAfterMs : Math.round((1000 * 2 ** attempt) * (0.5 + Math.random()));
      if (typeof onRetry === 'function') { try { onRetry({ attempt: attempt + 1, status: err.status || null, delayMs: delay, message: err.message }); } catch {} }
      await sleep(delay, signal);
      if (signal && signal.aborted) throw err;
    }
  }
}

module.exports = { withRetry, httpError, RETRYABLE_STATUS };
