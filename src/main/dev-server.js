'use strict';

// Long-lived processes (dev servers, watchers) for coding mode.
//
// run_command is one-shot and killed at its timeout — correct for builds and
// tests, useless for `npm run dev`: the server starts, prints its URL, and
// dies the moment the tool returns. This module keeps a server alive ACROSS
// turns, captures its output in a ring buffer, and detects the URL it is
// serving on, so the model can start it, read logs, and stop it.
//
// One server per project (starting a new one replaces the old). Everything is
// killed on app quit — never leave orphans.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const MAX_LOG_LINES = 400;
const DEFAULT_WAIT_MS = 12000;   // settle time before reporting back
const servers = new Map();       // projectId → record

// http://localhost:3000, http://127.0.0.1:8080, "Local: http://…"
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/i;
// "ready", "listening on", "compiled successfully", "server started"
const READY_RE = /\b(ready|listening|compiled successfully|server (?:started|running)|watching for file changes)\b/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function record(projectId) { return servers.get(String(projectId)) || null; }

function safeStaticPath(root, requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  const candidate = path.resolve(root, `.${pathname}`);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new Error('outside static root');
  return candidate;
}

async function safeRealPath(root, file) {
  const [realRoot, realFile] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(file)]);
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) throw new Error('symlink escapes static root');
  return realFile;
}

async function serveStatic(root, req, res) {
  try {
    let file = safeStaticPath(root, req.url || '/');
    if ((await fs.promises.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    file = await safeRealPath(root, file);
    const body = await fs.promises.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length }); res.end(body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
}

function pushLog(rec, chunk) {
  const text = chunk.toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    rec.logs.push(line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 500));
    if (rec.logs.length > MAX_LOG_LINES) rec.logs.shift();
    if (!rec.url) { const m = line.match(URL_RE); if (m) rec.url = m[0]; }
    if (READY_RE.test(line)) rec.ready = true;
  }
}

/**
 * Start (or restart) the project's long-lived process.
 * Resolves once the process looks ready, prints a URL, exits, or the wait
 * elapses — whichever comes first. The process keeps running after resolve.
 */
function start({ projectId, root, command, env, waitMs = DEFAULT_WAIT_MS }) {
  stop(projectId);
  const key = String(projectId);
  const child = spawn('/bin/zsh', ['-lc', command], { cwd: path.resolve(root), env, detached: false });
  const rec = { key, command, child, logs: [], url: null, ready: false, exited: false, exitCode: null, startedAt: Date.now() };
  servers.set(key, rec);
  child.stdout.on('data', (d) => pushLog(rec, d));
  child.stderr.on('data', (d) => pushLog(rec, d));
  child.on('error', (e) => { rec.exited = true; rec.error = e.message; });
  child.on('close', (code) => { rec.exited = true; rec.exitCode = code; });

  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const done = rec.exited || (rec.url && rec.ready) || Date.now() - t0 >= waitMs;
      if (!done) return;
      clearInterval(tick);
      resolve(describe(rec));
    }, 250);
  });
}

function startStatic({ projectId, root }) {
  stop(projectId);
  const key = String(projectId); const base = path.resolve(root);
  const server = http.createServer((req, res) => serveStatic(base, req, res));
  const rec = { key, command: '[framework static host]', server, logs: [], url: null, ready: false, exited: false, exitCode: null, startedAt: Date.now(), frameworkOwned: true };
  servers.set(key, rec);
  return new Promise((resolve, reject) => {
    server.once('error', (error) => { rec.exited = true; rec.error = error.message; reject(error); });
    server.listen(0, '127.0.0.1', () => { const address = server.address(); rec.url = `http://127.0.0.1:${address.port}/`; rec.ready = true; resolve(describe(rec)); });
  });
}

function stop(projectId) {
  const rec = record(projectId);
  if (!rec) return { stopped: false, reason: 'no server running' };
  try { if (!rec.exited && rec.server) rec.server.close(); else if (!rec.exited) rec.child.kill('SIGTERM'); } catch {}
  // Escalate if it ignores SIGTERM (dev servers with child processes do).
  if (rec.child) setTimeout(() => { try { if (!rec.exited) rec.child.kill('SIGKILL'); } catch {} }, 3000);
  servers.delete(rec.key);
  return { stopped: true, command: rec.command, ranMs: Date.now() - rec.startedAt };
}

function describe(rec) {
  return {
    running: !rec.exited,
    command: rec.command,
    url: rec.url || null,
    ready: rec.ready,
    exitCode: rec.exited ? rec.exitCode : null,
    error: rec.error || null,
    logs: rec.logs.slice(-40),
    uptimeMs: Date.now() - rec.startedAt,
    frameworkOwned: !!rec.frameworkOwned,
    verified: !!rec.verified,
    verifiedPaths: rec.verifiedPaths || []
  };
}

async function fetchHealth(url, timeoutMs = 3000) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const response = await fetch(url, { signal: ctrl.signal }); return response.ok; }
  catch { return false; } finally { clearTimeout(timer); }
}

async function health(projectId, paths = ['/']) {
  const rec = record(projectId);
  if (!rec || rec.exited || !rec.url) return { ...status(projectId), verified: false, verifiedPaths: [] };
  const results = await Promise.all(paths.map(async (item) => ({ path: item, ok: await fetchHealth(new URL(item, rec.url).toString()) })));
  rec.verified = results.length > 0 && results.every((item) => item.ok); rec.verifiedPaths = results.filter((item) => item.ok).map((item) => item.path);
  return { ...describe(rec), health: results };
}

function status(projectId) {
  const rec = record(projectId);
  return rec ? describe(rec) : { running: false, command: null, url: null, logs: [] };
}

function logs(projectId, lines = 60) {
  const rec = record(projectId);
  if (!rec) return { running: false, logs: [] };
  return { running: !rec.exited, url: rec.url, logs: rec.logs.slice(-Math.max(1, Math.min(lines, MAX_LOG_LINES))) };
}

/** Kill every managed process — called on app quit. */
function disposeAll() {
  for (const key of [...servers.keys()]) stop(key);
}

module.exports = { start, startStatic, health, stop, status, logs, disposeAll, MAX_LOG_LINES };
