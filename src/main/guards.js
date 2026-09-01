'use strict';

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(raw)) throw new Error('Guard URL must start with http:// or https://');
  return raw;
}

function healthUrl(baseUrl) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  u.pathname = u.pathname.replace(/\/v1\/?$/i, '').replace(/\/+$/, '') + '/health';
  u.search = ''; u.hash = '';
  return u.toString();
}

async function request(url, token, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: ctrl.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
    return body;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Guard connection timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function testGuard({ baseUrl, authMode = 'passthrough', secret = null }) {
  const base = normalizeBaseUrl(baseUrl);
  const token = authMode === 'bearer' ? secret : null;
  if (authMode === 'bearer' && !token) return { ok: false, error: 'Bearer authentication requires a guard token' };
  try {
    const body = await request(healthUrl(base), token);
    return { ok: true, detail: body && body.status ? String(body.status) : 'reachable' };
  } catch (healthError) {
    try {
      const body = await request(`${base}/models`, token);
      return { ok: true, detail: Array.isArray(body && body.data) ? `${body.data.length} models` : 'reachable' };
    } catch (modelsError) {
      return { ok: false, error: `Health check failed: ${healthError.message}; models check failed: ${modelsError.message}` };
    }
  }
}

module.exports = { normalizeBaseUrl, healthUrl, testGuard };
