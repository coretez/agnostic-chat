'use strict';

// Keeps MCP connections alive across chat turns and routes tool calls.
// Tools are namespaced `<server>__<tool>` so names never collide across servers.

const repo = require('../db/repo');
const { McpConnection } = require('./client');
const oauth = require('./oauth');

const connections = new Map(); // serverId -> McpConnection
const refreshingCalls = new Map(); // serverId -> one reactive refresh/reconnect
const authActivity = new Map(); // serverId -> renderer-safe lifecycle metadata
const authListeners = new Set();
const renewalTimers = new Map(); // serverId -> proactive OAuth renewal timer
const RENEWAL_SKEW_MS = 60000;

function renewalDelay(expiresAt, now = Date.now()) {
  return Math.max(0, Number(expiresAt || 0) - Number(now) - RENEWAL_SKEW_MS);
}

function scheduleAuthorizationRenewal(serverId, expiresAt) {
  const prior = renewalTimers.get(Number(serverId));
  if (prior) clearTimeout(prior);
  if (!Number(expiresAt)) return;
  const timer = setTimeout(async () => {
    renewalTimers.delete(Number(serverId));
    await refreshConnection(Number(serverId));
  }, renewalDelay(expiresAt));
  if (typeof timer.unref === 'function') timer.unref();
  renewalTimers.set(Number(serverId), timer);
}

function safeAuthDetail(detail) {
  return String(detail || '').replace(/((?:access|refresh)[_-]?token)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 300);
}

function publishAuth(serverId, state, detail = '', extra = {}) {
  const prior = authActivity.get(serverId) || {};
  const status = {
    serverId: Number(serverId), state,
    detail: safeAuthDetail(detail),
    expiresAt: Number(extra.expiresAt || prior.expiresAt) || null,
    lastRenewedAt: extra.lastRenewedAt || prior.lastRenewedAt || null,
    updatedAt: new Date().toISOString()
  };
  authActivity.set(Number(serverId), status);
  for (const fn of authListeners) { try { fn({ ...status }); } catch {} }
  return { ...status };
}

function authStatus(serverId = null) {
  const ids = serverId == null ? repo.mcp.list().filter((s) => s.transport === 'http').map((s) => s.id) : [Number(serverId)];
  return ids.map((id) => {
    if (authActivity.has(id)) {
      const status = { ...authActivity.get(id) };
      if (status.expiresAt && status.expiresAt <= Date.now() && ['connected', 'renewed'].includes(status.state)) {
        status.state = 'renewal_due';
        status.detail = 'Authorization renewal required';
      }
      return status;
    }
    const server = repo.mcp.get(id);
    const secret = repo.mcp.reveal(id) || {};
    const oauthExpired = Number(secret.oauth && secret.oauth.expires_at) > 0 && Number(secret.oauth.expires_at) <= Date.now();
    const oauthState = secret.oauth && secret.oauth.access_token
      ? (oauthExpired ? 'renewal_due' : 'connected')
      : (server && /auth|401/i.test(server.status_detail || '') ? 'reauth_required' : 'unknown');
    return { serverId: id, state: oauthState, detail: safeAuthDetail(server && server.status_detail), expiresAt: Number(secret.oauth && secret.oauth.expires_at) || null, lastRenewedAt: null, updatedAt: null };
  });
}

function onAuthStatus(listener) { authListeners.add(listener); return () => authListeners.delete(listener); }
function noteAuthorized(serverId, expiresAt = null) {
  deadGrants.delete(serverId);
  const stale = connections.get(Number(serverId));
  connections.delete(Number(serverId));
  try { if (stale) stale.close(); } catch {}
  return publishAuth(serverId, 'connected', 'Signed in', { expiresAt });
}

function sanitize(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_'); }
function isAuthFailure(error) { return /401|unauthor|invalid_token|token expired/i.test((error && error.message) || ''); }
function tokenNearExpiry(serverId, skewMs = 60000) {
  const secret = repo.mcp.reveal(serverId) || {};
  const expiresAt = secret.oauth && Number(secret.oauth.expires_at);
  return !!(expiresAt && secret.oauth.refresh_token && Date.now() >= expiresAt - skewMs);
}

// Sanity ceiling only — NOT the per-turn tool cap. Servers like Fluency Expo
// expose 200+ tools; buildToolset() returns the full catalog (relevance-based
// narrowing to what a turn actually needs happens in ipc.js, which has the
// user's request and can pick tools that fit it wherever they sit in the
// catalog). This ceiling just bounds the pathological case — an MCP server
// with an absurd tool count — so the selector's own menu prompt stays sane
// and a failed selection has a bounded fallback slice.
const MAX_TOOLS = 300;

// Servers whose grant the authorization server has revoked. A refresh token
// that has already been spent is not retryable: under rotation with replay
// detection, presenting it AGAIN is what tells the server a token was stolen,
// and the response is to revoke the whole family. So a dead grant is recorded
// here and never touched again this session — the only way back is a fresh
// interactive authorization.
const deadGrants = new Map(); // serverId -> reason

/** A refresh that must not be retried; the grant needs re-authorization. */
function markGrantDead(serverId, error) {
  const reason = (error && error.message) || 'refresh rejected';
  deadGrants.set(serverId, reason);
  console.error(`[mcp oauth] grant for server ${serverId} is DEAD (${reason}) — re-authorize; no further refresh will be attempted`);
  try { repo.mcp.update(serverId, { status: 'error', statusDetail: `Authorization expired — reconnect this server. (${reason})` }); } catch {}
  publishAuth(serverId, 'reauth_required', 'Authorization expired — sign in again');
}

/** Refresh once, persist the rotated token, and classify a fatal failure. */
async function refreshAndPersist(serverId, secret) {
  publishAuth(serverId, 'renewing', 'Renewing authorization', { expiresAt: secret.oauth && secret.oauth.expires_at });
  try {
    const refreshed = await oauth.refresh(secret.oauth);
    secret.oauth = { ...secret.oauth, ...refreshed };
    // Persist BEFORE the token is used: the old one is already spent, so a
    // rotated token that never reaches disk is a grant thrown away.
    repo.mcp.update(serverId, { secret });
    deadGrants.delete(serverId);
    publishAuth(serverId, 'renewed', 'Authorization renewed', { expiresAt: secret.oauth.expires_at, lastRenewedAt: new Date().toISOString() });
    scheduleAuthorizationRenewal(serverId, secret.oauth.expires_at);
    return true;
  } catch (e) {
    if (oauth.isDeadGrant(e)) markGrantDead(serverId, e);
    else {
      console.error('[mcp oauth] refresh failed (retryable)', e && e.message);
      publishAuth(serverId, 'error', 'Authorization renewal failed; retry is available');
    }
    return false;
  }
}

// Return a valid bearer token for a server, refreshing an expired OAuth token
// (and persisting the new one) when possible. Returns undefined when the token
// is expired and could not be renewed. Handing back a KNOWN-EXPIRED token only
// guarantees a 401, and that 401 used to trigger a SECOND refresh attempt which
// replayed the same spent token — two replays per connect, either one enough to
// make the authorization server revoke the grant.
async function bearerFor(serverId, secret) {
  if (!secret.oauth || !secret.oauth.access_token) return secret.token || undefined;
  const o = secret.oauth;
  const secsLeft = o.expires_at ? Math.round((o.expires_at - Date.now()) / 1000) : null;
  console.log(`[mcp oauth] server ${serverId} — hasRefreshToken:${!!o.refresh_token} expiresInSec:${secsLeft}`);
  const expired = o.expires_at && Date.now() > o.expires_at;
  const nearExpiry = o.expires_at && Date.now() > o.expires_at - 60000;
  if (nearExpiry && o.refresh_token && !deadGrants.has(serverId)) {
    const ok = await refreshAndPersist(serverId, secret);
    if (!ok && expired) return undefined;   // no point offering a dead token
  } else if (expired && deadGrants.has(serverId)) {
    return undefined;
  }
  return secret.oauth.access_token;
}

// Force an OAuth refresh using the stored refresh token; persist the new token.
async function tryRefresh(serverId) {
  if (deadGrants.has(serverId)) return false;   // never replay a spent token
  const secret = repo.mcp.reveal(serverId) || {};
  if (!secret.oauth || !secret.oauth.refresh_token) return false;
  const ok = await refreshAndPersist(serverId, secret);
  if (ok) console.log('[mcp oauth] token refreshed for server', serverId);
  return ok;
}

// Refresh a connection once for all concurrent callers. The old connection is
// kept usable until token rotation succeeds; only then is it replaced. This is
// used proactively near expiry and reactively after a 401.
async function refreshConnection(serverId) {
  let refresh = refreshingCalls.get(serverId);
  if (refresh) return refresh;
  refresh = (async () => {
    if (!await tryRefresh(serverId)) return false;
    const stale = connections.get(serverId);
    connections.delete(serverId);
    try { if (stale) stale.close(); } catch {}
    const server = repo.mcp.get(serverId);
    if (!server) return false;
    await ensure(server);
    return true;
  })().finally(() => refreshingCalls.delete(serverId));
  refreshingCalls.set(serverId, refresh);
  return refresh;
}

/** True when a server needs a fresh interactive authorization. */
function needsReauth(serverId) { return deadGrants.has(serverId); }

// Connections being opened right now, so two callers never refresh in parallel.
// Without this, a CONNECT click landing while a turn is starting gives both
// callers a cache miss, both refresh, and the loser presents a token the winner
// already spent — a self-inflicted replay that revokes the grant.
const opening = new Map(); // serverId -> Promise<McpConnection>

async function ensure(server) {
  const existing = connections.get(server.id);
  if (existing && existing.open) return existing;
  const inFlight = opening.get(server.id);
  if (inFlight) return inFlight;
  const p = openConnectionFor(server).finally(() => opening.delete(server.id));
  opening.set(server.id, p);
  return p;
}

async function connectionForServer(server) {
  const secret = repo.mcp.reveal(server.id) || {};
  const token = await bearerFor(server.id, secret);
  const connection = new McpConnection({ transport: server.transport, command: server.command, args: server.args, url: server.url, env: secret.env, token });
  return { connection, secret };
}

async function openWithAuthenticationRetry(server) {
  let built = await connectionForServer(server);
  try { await built.connection.openConnection(); return built; }
  catch (error) {
    if (isAuthFailure(error)) publishAuth(server.id, 'retrying', 'Authentication failed; renewing and retrying once');
    if (isAuthFailure(error) && await tryRefresh(server.id)) built = await connectionForServer(server);
    else if (needsReauth(server.id)) throw reauthError(server);
    else throw error;
    await built.connection.openConnection();
    return built;
  }
}

async function openConnectionFor(server) {
  if (needsReauth(server.id)) throw reauthError(server);
  const { connection, secret } = await openWithAuthenticationRetry(server);
  connections.set(server.id, connection);
  if (server.transport === 'http') {
    publishAuth(server.id, 'connected', 'Connected', { expiresAt: secret.oauth && secret.oauth.expires_at });
    scheduleAuthorizationRenewal(server.id, secret.oauth && secret.oauth.expires_at);
  }
  return connection;
}

// Tool discovery is an authenticated MCP operation too. An open HTTP stream
// can outlive its bearer token, so tools/list must receive the same one-time,
// single-flight refresh treatment as callTool. Otherwise a post-restart 401 is
// silently converted into an empty catalog while the UI still says connected.
async function listToolsWithRecovery(server, conn, deps = {}) {
  const refresh = deps.refreshConnection || refreshConnection;
  const getConnection = deps.getConnection || ((serverId) => connections.get(serverId));
  let active = conn;
  if (tokenNearExpiry(server.id)) {
    if (await refresh(server.id)) active = getConnection(server.id) || active;
  }
  try {
    return await active.listTools();
  } catch (error) {
    if (!isAuthFailure(error)) throw error;
    publishAuth(server.id, 'retrying', 'Tool catalog authentication failed; renewing and retrying once');
    if (!await refresh(server.id)) {
      if (needsReauth(server.id)) throw reauthError(server);
      publishAuth(server.id, 'error', 'Authorization renewal failed; tool catalog unavailable');
      throw error;
    }
    const retry = getConnection(server.id);
    if (!retry || !retry.open) throw error;
    return retry.listTools();
  }
}

/** The one error a revoked grant should ever produce. */
function reauthError(server) {
  const e = new Error(`${server.name}: authorization expired — reconnect this server to sign in again.`);
  e.code = 'MCP_NEEDS_REAUTH';
  return e;
}

/**
 * Connect all enabled MCP servers (skipping any that fail) and return their
 * tools plus a route map from namespaced tool name → {serverId, original}.
 */
async function buildToolset(projectId = null) {
  // Project scope (opt-out, mirrors project_skills): pass a projectId to keep
  // servers the project disabled out of the catalog entirely; without one
  // (imports, global probes) the full enabled list is used.
  const servers = (projectId != null ? repo.mcp.listEnabledForProject(projectId) : repo.mcp.list())
    .filter((s) => s.enabled);
  const tools = [];
  const routes = new Map();
  for (const s of servers) {
    let conn;
    try { conn = await ensure(s); } catch (e) { console.error('[mcp] connect failed', s.name, e && e.message); continue; }
    let list;
    try { list = await listToolsWithRecovery(s, conn); } catch (e) { console.error('[mcp] listTools failed', s.name, e && e.message); continue; }
    const prefix = sanitize(s.name) || `srv${s.id}`;
    for (const t of list) {
      const ns = `${prefix}__${t.name}`;
      // Preserve MCP safety annotations. The turn-level evidence cache uses
      // readOnlyHint when servers provide it and never caches declared writes.
      tools.push({ name: ns, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations || null });
      routes.set(ns, { serverId: s.id, original: t.name });
    }
  }
  if (tools.length > MAX_TOOLS) {
    console.warn(`[mcp] ${tools.length} tools available; sending only the first ${MAX_TOOLS} to the model (sanity ceiling).`);
    return { tools: tools.slice(0, MAX_TOOLS), routes, truncated: tools.length };
  }
  return { tools, routes };
}

// Connect a saved server (using its stored/OAuth token), cache the connection,
// and return its tools. Used by the "CONNECT" button on a saved server.
async function connectAndCache(serverId) {
  const s = repo.mcp.get(serverId);
  if (!s) return { ok: false, error: 'server not found' };
  try {
    const conn = await ensure(s);
    const tools = await listToolsWithRecovery(s, conn);
    return { ok: true, tools, serverInfo: conn.serverInfo };
  } catch (e) {
    connections.delete(serverId);
    if (isAuthFailure(e) && !needsReauth(serverId)) publishAuth(serverId, 'error', e.message);
    return { ok: false, error: e.message };
  }
}

async function callTool(namespaced, args, routes) {
  const route = routes.get(namespaced);
  if (!route) throw new Error(`unknown tool: ${namespaced}`);
  // Long report/investigation turns can outlive an access token. Refresh before
  // the boundary is crossed so the model never sees an avoidable 401. Parallel
  // calls share refreshConnection's single flight.
  if (tokenNearExpiry(route.serverId)) await refreshConnection(route.serverId);
  const conn = connections.get(route.serverId);
  if (!conn || !conn.open) throw new Error(`MCP server for ${namespaced} is not connected`);
  try {
    return await conn.callTool(route.original, args);
  } catch (error) {
    if (!isAuthFailure(error)) throw error;

    // A token can expire during a long plan after the connection was opened.
    // Refresh/reconnect once and replay only this failed tool call. Parallel
    // case investigations can all observe the same 401, so single-flight the
    // rotation: presenting a spent refresh token twice can revoke the grant.
    if (!await refreshConnection(route.serverId)) {
      if (needsReauth(route.serverId)) throw reauthError(repo.mcp.get(route.serverId) || { name: namespaced });
      throw error;
    }
    const retry = connections.get(route.serverId);
    if (!retry || !retry.open) throw error;
    return retry.callTool(route.original, args); // exactly one replay
  }
}

function disposeAll() {
  for (const timer of renewalTimers.values()) clearTimeout(timer);
  renewalTimers.clear();
  for (const connection of connections.values()) connection.close();
  connections.clear();
}

module.exports = { buildToolset, callTool, connectAndCache, listToolsWithRecovery, disposeAll, sanitize, needsReauth, isAuthFailure, tokenNearExpiry, renewalDelay, authStatus, onAuthStatus, noteAuthorized, publishAuth, MAX_TOOLS };
