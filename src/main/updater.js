'use strict';

// In-place update for the way Shamrock runs today: a git checkout. Check
// origin for new commits on the default branch, and on request fast-forward,
// refresh dependencies, and relaunch. The packaged-app path (signed build +
// electron-updater release feed) rides the distributable-build phase — this
// module reports it as such rather than pretending.
//
// Safety posture: ff-only (never merges over local work), refuses a dirty
// working tree with a clear message, and never updates without the user
// clicking the button the renderer shows.

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

function run(cmd, args, cwd = REPO_ROOT, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '', err = '';
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, timeoutMs);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
}

function isGitCheckout() {
  try { return fs.existsSync(path.join(REPO_ROOT, '.git')); } catch { return false; }
}

/** @returns {{available:boolean, behind?:number, latest?:string, mode:string, error?:string}} */
async function checkForUpdate() {
  if (app.isPackaged) return { available: false, mode: 'packaged', error: 'packaged builds update via the release channel (not yet published)' };
  if (!isGitCheckout()) return { available: false, mode: 'none', error: 'not a git checkout' };
  const fetch = await run('git', ['fetch', 'origin', '--quiet']);
  if (fetch.code !== 0) return { available: false, mode: 'git', error: `fetch failed: ${fetch.err || fetch.out}`.slice(0, 200) };
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main';
  const count = await run('git', ['rev-list', '--count', `HEAD..origin/${branch}`]);
  const behind = Number(count.out) || 0;
  if (!behind) return { available: false, mode: 'git', behind: 0 };
  const latest = (await run('git', ['log', '-1', '--format=%s', `origin/${branch}`])).out;
  return { available: true, mode: 'git', behind, latest };
}

/** Fast-forward, refresh deps, relaunch. Resolves only on failure — success restarts the app. */
async function applyUpdate(onPhase = () => {}) {
  if (app.isPackaged || !isGitCheckout()) return { ok: false, error: 'in-place update only supports git checkouts' };
  const dirty = await run('git', ['status', '--porcelain']);
  if (dirty.out.trim()) return { ok: false, error: 'working tree has local changes — commit or stash them first' };
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'main';
  onPhase('pull');
  const pull = await run('git', ['pull', '--ff-only', 'origin', branch]);
  if (pull.code !== 0) return { ok: false, error: `pull failed: ${(pull.err || pull.out).slice(0, 200)}` };
  onPhase('deps');
  const npm = await run('npm', ['install', '--no-audit', '--no-fund'], REPO_ROOT, 300000);
  if (npm.code !== 0) return { ok: false, error: `npm install failed: ${(npm.err || npm.out).slice(0, 200)}` };
  onPhase('restart');
  app.relaunch();
  app.exit(0);
  return { ok: true };   // unreachable in practice; exit wins
}

module.exports = { checkForUpdate, applyUpdate };
