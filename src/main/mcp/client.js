'use strict';

// Model Context Protocol client (main process only).
// A persistent connection (stdio or streamable-http) that can initialize,
// list tools, and call tools. `connectAndList` is a one-shot helper for the
// "CONNECT" button (open → list → close); `McpConnection` is kept alive by the
// manager for actual tool calls during chat.

const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'Shamrock', version: '0.1.0' };

function shapeTools(result) {
  const tools = (result && result.tools) || [];
  return tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object' }, meta: t._meta || null }));
}
function toText(result) {
  if (Array.isArray(result?.content)) return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (typeof result?.content === 'string') return result.content;
  return JSON.stringify(result ?? {});
}

class McpConnection {
  constructor(cfg, { timeoutMs = 20000 } = {}) {
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.buf = '';
    this.stderr = '';
    this.idc = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.open = false;
    this.serverInfo = null;
  }

  async openConnection() {
    if (this.cfg.transport === 'http') {
      if (!this.cfg.url) throw new Error('no URL');
    } else {
      if (!this.cfg.command) throw new Error('no command');
      this.child = spawn(this.cfg.command, Array.isArray(this.cfg.args) ? this.cfg.args : [], {
        env: { ...process.env, ...(this.cfg.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.child.on('error', (e) => this._fail(e));
      this.child.on('exit', (code) => { this.open = false; this._fail(new Error(`server exited (code ${code})${this.stderr ? ' · ' + this.stderr.slice(0, 200) : ''}`)); });
      this.child.stderr.on('data', (d) => { this.stderr += d.toString(); });
      this.child.stdout.on('data', (d) => {
        this.buf += d.toString();
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id !== undefined && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); p.resolve(msg); }
        }
      });
    }

    const init = await this._request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    if (init.error) throw new Error(init.error.message || 'initialize failed');
    this.serverInfo = init.result && init.result.serverInfo;
    await this._notify('notifications/initialized');
    this.open = true;
    return this.serverInfo;
  }

  async listTools() {
    const r = await this._request('tools/list', {});
    if (r.error) throw new Error(r.error.message || 'tools/list failed');
    return shapeTools(r.result);
  }

  async callTool(name, args) {
    const r = await this._request('tools/call', { name, arguments: args || {} });
    if (r.error) throw new Error(r.error.message || 'tools/call failed');
    const result = r.result || {};
    return { text: toText(result), isError: !!result.isError, raw: result };
  }

  // Resources — foundation for MCP Apps / widget UIs (ui:// resources).
  async listResources() {
    const r = await this._request('resources/list', {});
    if (r.error) throw new Error(r.error.message || 'resources/list failed');
    return (r.result && r.result.resources) || [];
  }
  async readResource(uri) {
    const r = await this._request('resources/read', { uri });
    if (r.error) throw new Error(r.error.message || 'resources/read failed');
    return (r.result && r.result.contents) || [];
  }

  close() {
    this.open = false;
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
    this._fail(new Error('connection closed'));
  }

  _fail(err) { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); }

  _request(method, params) {
    if (this.cfg.transport === 'http') return this._httpRequest(method, params, false);
    return new Promise((resolve, reject) => {
      const id = ++this.idc;
      const msg = { jsonrpc: '2.0', id, method };
      if (params) msg.params = params;
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`MCP request timed out: ${method}`)); } }, this.timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { this.child.stdin.write(JSON.stringify(msg) + '\n'); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  _notify(method, params) {
    if (this.cfg.transport === 'http') return this._httpRequest(method, params, true).catch(() => {});
    const msg = { jsonrpc: '2.0', method };
    if (params) msg.params = params;
    try { this.child.stdin.write(JSON.stringify(msg) + '\n'); } catch {}
    return Promise.resolve();
  }

  async _httpRequest(method, params, notify) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const body = { jsonrpc: '2.0', method };
      if (params) body.params = params;
      if (!notify) body.id = ++this.idc;
      const res = await fetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      const sid = res.headers.get('mcp-session-id'); if (sid) this.sessionId = sid;
      if (notify) return null;
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) {
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { const j = JSON.parse(line.slice(5).trim()); if (j && (j.result || j.error)) return j; } catch {}
        }
        throw new Error('no JSON-RPC payload in SSE response');
      }
      return JSON.parse(text);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`timed out after ${this.timeoutMs / 1000}s`);
      // Node's fetch throws an opaque "fetch failed"; surface the real cause.
      const cause = e.cause && (e.cause.code || e.cause.message);
      throw new Error(cause ? `${e.message} (${cause})` : e.message);
    } finally { clearTimeout(t); }
  }
}

/** One-shot: open, list tools, close. Used by the "CONNECT" button / test. */
async function connectAndList(cfg, opts) {
  const c = new McpConnection(cfg, opts);
  try {
    await c.openConnection();
    const tools = await c.listTools();
    return { ok: true, tools, serverInfo: c.serverInfo };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    c.close();
  }
}

module.exports = { McpConnection, connectAndList, PROTOCOL_VERSION };
