'use strict';

// Provider errors carry a CODE, not a sentence.
//
// The connectors used to catch a structured AbortError and rethrow
// `new Error('Request timed out after 300s')` — flattening machine-readable
// state into English. Downstream, execute.js then had to sniff that English
// back with `/\baborted\b/i`, which also matched unrelated failures and
// silently retried them (caught by smoke on 2026-08-14). Prose is a lossy
// encoding of something the code already knew.
//
// So: one vocabulary, set at the point the cause is actually known, read by
// exact comparison everywhere else. The message stays human-readable for logs
// and the UI; nothing branches on it.

const CODES = {
  USER_ABORT: 'USER_ABORT',           // the user pressed STOP — not a fault
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT', // connector gave up waiting (idle/stall)
  STREAM_STALLED: 'STREAM_STALLED'    // stream opened, then went silent
};

/**
 * Build a provider error carrying its cause as data.
 * @param {string} code one of CODES
 * @param {string} message human-readable, for logs and the UI only
 */
function providerError(code, message) {
  const e = new Error(message);
  e.code = code;
  e.providerError = true;
  return e;
}

/** Did the PROVIDER give up (as opposed to the user stopping)? */
const isTimeoutCode = (code) => code === CODES.PROVIDER_TIMEOUT || code === CODES.STREAM_STALLED;

module.exports = { CODES, providerError, isTimeoutCode };
