'use strict';

const { CODES, providerError } = require('./errors');
const { httpError, withRetry } = require('./retry');

function linkAbortSignal(controller, signal) {
  if (!signal) return;
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
}

function guardMetadata(response) {
  return {
    blocked: response.headers.get('x-trylon-blocked') === 'true',
    stage: response.headers.get('x-trylon-stage'),
    safetyCode: response.headers.get('x-trylon-safety-code'),
    action: response.headers.get('x-trylon-action'),
    message: response.headers.get('x-trylon-message'),
    requestId: response.headers.get('x-request-id')
  };
}

function requestAbortError(error, signal, timeoutMs) {
  if (error.name !== 'AbortError') return error;
  return signal?.aborted
    ? providerError(CODES.USER_ABORT, 'stopped by user')
    : providerError(CODES.PROVIDER_TIMEOUT, `Request timed out after ${timeoutMs / 1000}s`);
}

async function requestJson(url, { headers, method = 'GET', body, timeoutMs = 30000, signal }) {
  const controller = new AbortController();
  linkAbortSignal(controller, signal);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!response.ok) {
      const detail = json?.error?.message || json?.message || text.slice(0, 400);
      throw httpError(response.status, detail, response.headers.get('retry-after'));
    }
    return { json, responseMeta: guardMetadata(response) };
  } catch (error) { throw requestAbortError(error, signal, timeoutMs); }
  finally { clearTimeout(timeout); }
}

function createStreamDeadline(signal, timeoutMs, idleMs = 300000) {
  const controller = new AbortController();
  linkAbortSignal(controller, signal);
  const state = { reason: '', idleTimer: null, totalTimer: null };
  const abort = (reason) => { state.reason = reason; controller.abort(); };
  const bump = () => {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => abort('idle'), idleMs);
  };
  bump();
  state.totalTimer = setTimeout(() => abort('total'), timeoutMs);
  const clear = () => { clearTimeout(state.idleTimer); clearTimeout(state.totalTimer); };
  const timeoutError = () => providerError(
    state.reason === 'total' ? CODES.PROVIDER_TIMEOUT : CODES.STREAM_STALLED,
    state.reason === 'total' ? `stream exceeded the ${Math.round(timeoutMs / 1000)}s wall-clock limit` : 'stream stalled (no data)'
  );
  return { controller, bump, clear, timeoutError };
}

function streamConnectionError(error, signal, deadline) {
  if (error.name === 'AbortError') {
    return signal?.aborted ? providerError(CODES.USER_ABORT, 'stopped by user') : deadline.timeoutError();
  }
  const retryableError = new Error(`stream connect failed: ${error.message}`);
  retryableError.retryable = true;
  return retryableError;
}

async function connectStream({ url, headers, body, signal, onRetry, deadline }) {
  return withRetry(async () => {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: deadline.controller.signal
      });
    } catch (error) { throw streamConnectionError(error, signal, deadline); }
    if (!response.ok) {
      const text = await response.text();
      throw httpError(response.status, text.slice(0, 400), response.headers.get('retry-after'));
    }
    return response;
  }, { retries: 3, signal: deadline.controller.signal, onRetry });
}

module.exports = { requestJson, linkAbortSignal, guardMetadata, createStreamDeadline, connectStream };
