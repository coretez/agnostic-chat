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
const path = require('node:path');

const MAX_LOG_LINES = 400;
const DEFAULT_WAIT_MS = 12000;   // settle time before reporting back
const servers = new Map();       // projectId → record

// http://localhost:3000, http://127.0.0.1:8080, "Local: http://…"
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/i;
// "ready", "listening on", "compiled successfully", "server started"
const READY_RE = /\b(ready|listening|compiled successfully|server (?:started|running)|watching for file changes)\b/i;

function record(projectId) { return servers.get(String(projectId)) || null; }

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

function stop(projectId) {
  const rec = record(projectId);
  if (!rec) return { stopped: false, reason: 'no server running' };
  try { if (!rec.exited) rec.child.kill('SIGTERM'); } catch {}
  // Escalate if it ignores SIGTERM (dev servers with child processes do).
  setTimeout(() => { try { if (!rec.exited) rec.child.kill('SIGKILL'); } catch {} }, 3000);
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
    uptimeMs: Date.now() - rec.startedAt
  };
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

module.exports = { start, stop, status, logs, disposeAll, MAX_LOG_LINES };
