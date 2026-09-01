'use strict';

// MCP OAuth 2.1 authorization (main process only).
// Implements the MCP Authorization spec for remote servers:
//   discover protected-resource + auth-server metadata → dynamic client
//   registration → PKCE authorization-code via the system browser + a loopback
//   redirect → token exchange → refresh. Tokens are returned to the caller to be
//   stored encrypted; this module never persists anything itself.

const crypto = require('node:crypto');
const http = require('node:http');

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}${j && j.error ? ': ' + (j.error_description || j.error) : ''}`);
      // Keep the MACHINE-READABLE code. "invalid_grant" is the difference
      // between "try again in a moment" and "this grant is gone forever", and
      // that distinction cannot be recovered from the prose afterwards.
      err.oauthError = (j && j.error) || null;
      err.status = res.status;
      throw err;
    }
    return j;
  } finally { clearTimeout(t); }
}

async function fetchForm(url, form, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
      signal: ctrl.signal
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}${j && j.error ? ': ' + (j.error_description || j.error) : ''}`);
      // Keep the MACHINE-READABLE code. "invalid_grant" is the difference
      // between "try again in a moment" and "this grant is gone forever", and
      // that distinction cannot be recovered from the prose afterwards.
      err.oauthError = (j && j.error) || null;
      err.status = res.status;
      throw err;
    }
    return j;
  } finally { clearTimeout(t); }
}

/** Discover the protected-resource + authorization-server metadata. */
async function discover(serverUrl) {
  const url = new URL(serverUrl);
  const origin = url.origin;
  let resource = null;
  for (const u of [`${origin}/.well-known/oauth-protected-resource${url.pathname}`, `${origin}/.well-known/oauth-protected-resource`]) {
    try { resource = await fetchJson(u); if (resource) break; } catch {}
  }
  const authServer = (resource && resource.authorization_servers && resource.authorization_servers[0]) || origin;
  const scope = (resource && resource.scopes_supported && resource.scopes_supported.join(' ')) || '';

  let as = null;
  for (const u of [`${authServer}/.well-known/oauth-authorization-server`, `${authServer}/.well-known/openid-configuration`]) {
    try { as = await fetchJson(u); if (as) break; } catch {}
  }
  if (!as || !as.authorization_endpoint || !as.token_endpoint) throw new Error('could not read authorization-server metadata');
  return { authServer, as, scope };
}

async function registerClient(endpoint, redirectUri, scope) {
  const r = await fetchJson(endpoint, {
    method: 'POST',
    body: {
      client_name: 'Shamrock',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope ? { scope } : {})
    }
  });
  if (!r || !r.client_id) throw new Error('dynamic client registration failed');
  return r;
}

/** Start a loopback HTTP server to catch the OAuth redirect. */
function startLoopback() {
  return new Promise((resolve, reject) => {
    let resolveCode, rejectCode;
    const codeP = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,sans-serif;text-align:center;padding:48px;color:#222"><h2>Authentication complete</h2><p>You can close this window and return to Agnostic Chat.</p></body>');
      const err = u.searchParams.get('error');
      if (err) rejectCode(new Error(`authorization error: ${u.searchParams.get('error_description') || err}`));
      else resolveCode({ code: u.searchParams.get('code'), state: u.searchParams.get('state') });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        waitForCode: (ms = 300000) => Promise.race([codeP, new Promise((_, rej) => setTimeout(() => rej(new Error('sign-in timed out')), ms))])
      });
    });
  });
}

async function exchangeCode(tokenEndpoint, { code, redirectUri, clientId, clientSecret, verifier }) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier });
  if (clientSecret) form.set('client_secret', clientSecret);
  const r = await fetchForm(tokenEndpoint, form);
  if (!r || !r.access_token) throw new Error('token exchange returned no access_token');
  return r;
}

/**
 * True when a refresh failure means the GRANT IS DEAD, not that the network
 * hiccuped. Servers that rotate refresh tokens (OAuth 2.1 / RFC 6819 §5.2.2.3)
 * treat a second presentation of a spent token as evidence of theft and revoke
 * the whole token family — so retrying does not just fail, it is the thing that
 * destroys the grant. `invalid_grant` is the standard code; the replay wording
 * is matched too because not every server sets the code.
 */
function isDeadGrant(error) {
  if (!error) return false;
  if (error.oauthError === 'invalid_grant' || error.oauthError === 'invalid_request') return true;
  return /replay detected|token (?:has been )?revoked|refresh token (?:is )?(?:invalid|expired)/i.test(error.message || '');
}

/** Refresh an access token. Returns the fields to merge into the stored token set. */
async function refresh(oauth) {
  if (!oauth.refresh_token) throw new Error('no refresh token');
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oauth.refresh_token, client_id: oauth.client_id });
  if (oauth.client_secret) form.set('client_secret', oauth.client_secret);
  const r = await fetchForm(oauth.token_endpoint, form);
  if (!r || !r.access_token) throw new Error('token refresh returned no access_token');
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token || oauth.refresh_token,
    expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : null
  };
}

/**
 * Run the full interactive flow. `openExternal(url)` opens the system browser.
 * @returns {Promise<object>} token set to store encrypted
 */
function authorizationUrl(as, registration, redirectUri, pkce, state, scope) {
  const parameters = new URLSearchParams({
    response_type: 'code', client_id: registration.client_id, redirect_uri: redirectUri,
    code_challenge: pkce.challenge, code_challenge_method: 'S256', state,
    ...(scope ? { scope } : {})
  });
  return `${as.authorization_endpoint}?${parameters}`;
}

function storedTokenSet(token, registration, as, scope) {
  return {
    access_token: token.access_token, refresh_token: token.refresh_token || null,
    expires_at: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
    client_id: registration.client_id, client_secret: registration.client_secret || null,
    token_endpoint: as.token_endpoint, scope
  };
}

async function authorizeWithLoopback(as, scope, loopback, openExternal) {
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;
  if (!as.registration_endpoint) throw new Error('server does not support dynamic client registration');
  const registration = await registerClient(as.registration_endpoint, redirectUri, scope);
  const pkce = buildPkce();
  const state = base64url(crypto.randomBytes(16));
  await openExternal(authorizationUrl(as, registration, redirectUri, pkce, state, scope));
  const returned = await loopback.waitForCode();
  if (!returned.code) throw new Error('no authorization code returned');
  if (returned.state !== state) throw new Error('state mismatch (possible CSRF)');
  const token = await exchangeCode(as.token_endpoint, {
    code: returned.code, redirectUri, clientId: registration.client_id,
    clientSecret: registration.client_secret, verifier: pkce.verifier
  });
  return storedTokenSet(token, registration, as, scope);
}

async function runAuthFlow(serverUrl, { openExternal }) {
  const { as, scope } = await discover(serverUrl);
  const loopback = await startLoopback();
  try { return await authorizeWithLoopback(as, scope, loopback, openExternal); }
  finally { loopback.server.close(); }
}

module.exports = {
  isDeadGrant, runAuthFlow, refresh, discover, buildPkce, startLoopback, base64url };
