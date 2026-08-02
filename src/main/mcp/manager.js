'use strict';

// Keeps MCP connections alive across chat turns and routes tool calls.
// Tools are namespaced `<server>__<tool>` so names never collide across servers.

const repo = require('../db/repo');
const { McpConnection } = require('./client');
const oauth = require('./oauth');

const connections = new Map(); // serverId -> McpConnection

function sanitize(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_'); }

// Cap tools sent to the model. Servers like Fluency Expo expose 200+ tools;
// sending them all is slow, token-heavy, and exceeds provider function limits.
const MAX_TOOLS = 32;

// Return a valid bearer token for a server, refreshing an expired OAuth token
// (and persisting the new one) when possible.
async function bearerFor(serverId, secret) {
  if (!secret.oauth || !secret.oauth.access_token) return secret.token || undefined;
  const o = secret.oauth;
  const secsLeft = o.expires_at ? Math.round((o.expires_at - Date.now()) / 1000) : null;
  console.log(`[mcp oauth] server ${serverId} — hasRefreshToken:${!!o.refresh_token} expiresInSec:${secsLeft}`);
  const nearExpiry = o.expires_at && Date.now() > o.expires_at - 60000;
  if (nearExpiry && o.refresh_token) {
    try {
      const refreshed = await oauth.refresh(o);
      secret.oauth = { ...o, ...refreshed };
      repo.mcp.update(serverId, { secret });
    } catch (e) { console.error('[mcp oauth] refresh failed', e && e.message); }
  }
  return secret.oauth.access_token;
}

// Force an OAuth refresh using the stored refresh token; persist the new token.
async function tryRefresh(serverId) {
  const secret = repo.mcp.reveal(serverId) || {};
  if (!secret.oauth || !secret.oauth.refresh_token) return false;
  try {
    const r = await oauth.refresh(secret.oauth);
    secret.oauth = { ...secret.oauth, ...r };
    repo.mcp.update(serverId, { secret });
    console.log('[mcp oauth] token refreshed for server', serverId);
    return true;
  } catch (e) { console.error('[mcp oauth] refresh failed', e && e.message); return false; }
}

async function ensure(server) {
  const existing = connections.get(server.id);
  if (existing && existing.open) return existing;
  const mk = async () => {
    const secret = repo.mcp.reveal(server.id) || {};
    const token = await bearerFor(server.id, secret); // proactively refreshes near expiry
    return new McpConnection({ transport: server.transport, command: server.command, args: server.args, url: server.url, env: secret.env, token });
  };
  let conn = await mk();
  try {
    await conn.openConnection();
  } catch (e) {
    // Reactive: on an auth failure, refresh the token and retry once.
    if (/401|unauthor|invalid_token/i.test(e.message || '') && await tryRefresh(server.id)) {
      conn = await mk();
      await conn.openConnection();
    } else throw e;
  }
  connections.set(server.id, conn);
  return conn;
}

/**
 * Connect all enabled MCP servers (skipping any that fail) and return their
 * tools plus a route map from namespaced tool name → {serverId, original}.
 */
async function buildToolset() {
  const servers = repo.mcp.list().filter((s) => s.enabled);
  const tools = [];
  const routes = new Map();
  for (const s of servers) {
    let conn;
    try { conn = await ensure(s); } catch (e) { console.error('[mcp] connect failed', s.name, e && e.message); continue; }
    let list;
    try { list = await conn.listTools(); } catch (e) { console.error('[mcp] listTools failed', s.name, e && e.message); continue; }
    const prefix = sanitize(s.name) || `srv${s.id}`;
    for (const t of list) {
      const ns = `${prefix}__${t.name}`;
      tools.push({ name: ns, description: t.description, inputSchema: t.inputSchema });
      routes.set(ns, { serverId: s.id, original: t.name });
    }
  }
  if (tools.length > MAX_TOOLS) {
    console.warn(`[mcp] ${tools.length} tools available; sending only the first ${MAX_TOOLS} to the model (cap). Per-server tool selection is the proper fix.`);
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
    const tools = await conn.listTools();
    return { ok: true, tools, serverInfo: conn.serverInfo };
  } catch (e) {
    connections.delete(serverId);
    return { ok: false, error: e.message };
  }
}

async function callTool(namespaced, args, routes) {
  const route = routes.get(namespaced);
  if (!route) throw new Error(`unknown tool: ${namespaced}`);
  const conn = connections.get(route.serverId);
  if (!conn || !conn.open) throw new Error(`MCP server for ${namespaced} is not connected`);
  return conn.callTool(route.original, args);
}

function disposeAll() { for (const c of connections.values()) c.close(); connections.clear(); }

module.exports = { buildToolset, callTool, connectAndCache, disposeAll };
