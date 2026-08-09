'use strict';

// Coding-harness tool pack: file + shell tools for a chat with coding mode ON.
// Permissions are a HIERARCHY (the internal planning-architecture record §13c):
//
//   1. Scope — never bypassable. Every file action must resolve inside an
//      allowed root: the project's working directory or its documents
//      directory. Relative paths resolve against the working directory;
//      absolute paths are allowed only when they land inside a root.
//   2. Action gating — reads (read_file, list_dir, grep_files) are free;
//      mutations pause for user approval via the injected approveAction
//      callback. The caller prices IRREVERSIBILITY there: file writes in a
//      git working tree auto-approve (rollback exists; per-file prompts don't
//      scale to real projects), shell always asks unless bypassed.
//   3. Bypass — the per-project `coding_bypass` setting skips mutation
//      approvals, and is honored ONLY when the working directory is a git
//      repository (hasGit below): git is the rollback story that makes
//      unattended writes acceptable. Enforced main-side in ipc.js AND hidden
//      renderer-side when git is absent.
//
// run_command executes with cwd = working directory, but a shell is inherently
// unjailed (it can cd anywhere) — that is exactly why it sits at level 2 even
// though the file tools' reads do not.
//
// Every tool returns {text, isError} like an MCP call, so the loops treat them
// identically — filtering, tracing, and variable capture all just work.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const devServer = require('./dev-server');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.cache', '.versions', '__pycache__', '.venv', 'venv']);
const MAX_READ = 48000;        // chars from read_file before eliding (filter caps again at 24k)
const MAX_ENTRIES = 300;       // list_dir entries
const MAX_MATCHES = 200;       // grep_files matches
const GREP_FILE_CAP = 1048576; // skip files > 1MB when grepping
const MAX_SHELL_OUT = 48000;   // combined stdout+stderr chars kept

const TOOLS = [
  {
    name: 'read_file',
    description:
      'Read a text file inside the project working directory or the project documents directory. '
      + 'Relative paths resolve against the working directory. Optional offset (1-based start line) '
      + 'and limit (line count) for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to the working directory, or absolute inside an allowed directory).' },
        offset: { type: 'number', description: 'Start line (1-based). Omit to read from the top.' },
        limit: { type: 'number', description: 'Max lines to return.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file inside the working or documents directory. Parent folders are '
      + 'created as needed. Auto-approved when the working directory is a git repo (rollback '
      + 'exists); otherwise the user approves each write — if declined, continue without it '
      + 'rather than retrying. For small changes to an existing file prefer edit_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to the working directory, or absolute inside an allowed directory).' },
        content: { type: 'string', description: 'The complete file content to write.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file inside the working or documents directory. old_string must '
      + 'match the file content exactly (including whitespace) and be unique unless replace_all is '
      + 'true. Read the file first to copy the exact text. Auto-approved when the working '
      + 'directory is a git repo; otherwise the user approves each edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to the working directory, or absolute inside an allowed directory).' },
        old_string: { type: 'string', description: 'Exact existing text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default: false, requires a unique match).' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'list_dir',
    description:
      'List files and folders inside the working or documents directory (recursive, shallow by '
      + 'default). Skips dependency/build folders like node_modules and .git.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder to list (default: the working directory).' },
        depth: { type: 'number', description: 'Recursion depth (default 2).' }
      }
    }
  },
  {
    name: 'grep_files',
    description:
      'Search file contents inside the working or documents directory with a regular expression '
      + '(falls back to a literal search if the pattern is not a valid regex). Returns '
      + 'path:line: text matches. Skips binary files and dependency/build folders.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex (JavaScript syntax) or literal text to find.' },
        path: { type: 'string', description: 'Folder to search (default: the whole working directory).' },
        ext: { type: 'string', description: 'Only search files with this extension, e.g. "js" or ".py".' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'start_server',
    description:
      'Start a long-running process (dev server, watcher) in the working directory and LEAVE IT '
      + 'RUNNING across turns — use this for `npm run dev`, not run_command, which kills the '
      + 'process when it returns. Returns the detected URL plus the first output. Starting again '
      + 'replaces the previous server.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run, e.g. "npm run dev".' },
        wait_seconds: { type: 'number', description: 'How long to wait for it to report ready before returning (default 12, max 60).' }
      },
      required: ['command']
    }
  },
  {
    name: 'server_logs',
    description: 'Read recent output from the running server started with start_server — use to diagnose a failed start or a runtime error.',
    inputSchema: {
      type: 'object',
      properties: { lines: { type: 'number', description: 'How many recent lines to return (default 60).' } }
    }
  },
  {
    name: 'stop_server',
    description: 'Stop the running server started with start_server.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'run_command',
    description:
      'Run a shell command with the project working directory as the current directory. The user '
      + 'approves each command unless they enabled bypass for this project — if a command is '
      + 'declined, continue without it rather than retrying. Returns the exit code plus '
      + 'stdout/stderr. Use for builds, tests, git, and anything the file tools cannot do.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run (zsh).' },
        timeout_seconds: { type: 'number', description: 'Kill the command after this many seconds (default 60, max 300).' }
      },
      required: ['command']
    }
  }
];

/** Is this directory a git repository? (.git may be a dir, or a file in worktrees.)
 *  This is the level-3 gate: bypass is only honored when rollback is possible. */
function hasGit(dir) {
  try { return !!dir && fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

/** Initialize a git repo in dir (the one-click fix the no-git prompts offer —
 *  the system asks instead of just refusing). Deterministic, never model-run. */
function initGit(dir) {
  try {
    const r = require('node:child_process').spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || 'git init failed').trim() };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// O9: the plan is the git history. Commit the working tree after a completed
// step, with the step's `produces` as the message. Framework bookkeeping — it
// does NOT pass through the approval gate (nothing new is being done to the
// tree; it is being recorded). Best-effort: a clean tree, a missing repo, or
// a failing commit resolves {committed:false} and never breaks the turn.
function commitStep(root, message) {
  const env = { ...shellEnv(), GIT_TERMINAL_PROMPT: '0' };
  const git = (args) => new Promise((res) => {
    const c = spawn('git', args, { cwd: path.resolve(root), env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('error', () => res({ code: -1, out }));
    c.on('close', (code) => res({ code, out }));
  });
  return (async () => {
    const st = await git(['status', '--porcelain']);
    if (st.code !== 0) return { committed: false, reason: 'not a git repo' };
    if (!st.out.trim()) return { committed: false, reason: 'clean tree' };
    await git(['add', '-A']);
    const cm = await git(['commit', '--no-verify', '-m', String(message || 'step').slice(0, 200)]);
    return { committed: cm.code === 0, reason: cm.code === 0 ? '' : cm.out.trim().slice(0, 200) };
  })();
}

// Resolve the symlink chain of `abs` even when the leaf doesn't exist yet
// (writes create files): realpath the deepest EXISTING ancestor, then re-append
// the untraversed tail. A symlinked parent OR a symlinked leaf both resolve to
// their true location before the jail check sees them.
function realResolve(abs) {
  let dir = abs;
  const tail = [];
  for (;;) {
    try { return tail.length ? path.join(fs.realpathSync(dir), ...tail.reverse()) : fs.realpathSync(dir); }
    catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;      // hit the fs root without an existing ancestor
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

// Level 1 — the scope jail. Resolve against the primary root (working dir);
// accept only paths that land inside one of the allowed roots. The check runs
// on REAL paths (symlinks resolved) — a link inside the jail pointing outside
// is outside. Prefix checks on lexical paths alone are escapable.
function makeJail(roots) {
  const bases = roots.filter(Boolean).map((r) => realResolve(path.resolve(r)));
  const primary = bases[0];
  const inside = (abs) => bases.find((b) => abs === b || abs.startsWith(b + path.sep));
  const resolve = (p) => {
    const abs = realResolve(path.resolve(primary, String(p == null || p === '' ? '.' : p)));
    if (!inside(abs)) throw new Error(`path is outside the working and documents directories: ${p}`);
    return abs;
  };
  // Display form: relative to the working dir when inside it, else absolute
  // (documents dir) — always a string the model can pass back to these tools.
  const display = (abs) => {
    const b = inside(abs);
    if (b === primary) return path.relative(primary, abs) || '.';
    return abs;
  };
  return { resolve, display, primary };
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function* walkFiles(dir, depth = Infinity) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    // allow plain dotfiles but never descend into dot-directories (.git etc.)
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield { abs, dir: true };
      if (depth > 1) yield* walkFiles(abs, depth - 1);
    } else if (e.isFile()) {
      yield { abs, dir: false };
    }
  }
}

function readFileTool(jail, args) {
  const abs = jail.resolve(args.path);
  const st = fs.statSync(abs);
  if (st.isDirectory()) return { text: `${args.path} is a directory — use list_dir.`, isError: true };
  const buf = fs.readFileSync(abs);
  if (isProbablyBinary(buf)) return { text: `${args.path} looks binary (${st.size} bytes) — not readable as text.`, isError: true };
  let text = buf.toString('utf8');
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Number(args.limit) || 0;
  if (offset > 1 || limit > 0) {
    const lines = text.split('\n');
    const slice = lines.slice(offset - 1, limit > 0 ? offset - 1 + limit : undefined);
    text = slice.join('\n');
    text = `[lines ${offset}-${offset - 1 + slice.length} of ${lines.length}]\n` + text;
  }
  if (text.length > MAX_READ) {
    text = text.slice(0, MAX_READ) + `\n… [truncated — ${st.size} bytes total; re-read with offset/limit for the rest]`;
  }
  return { text };
}

function writeFileTool(jail, args) {
  const abs = jail.resolve(args.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const content = String(args.content ?? '');
  fs.writeFileSync(abs, content, 'utf8');
  return { text: `Wrote ${content.length} chars to ${jail.display(abs)}` };
}

function editFileTool(jail, args) {
  const abs = jail.resolve(args.path);
  const text = fs.readFileSync(abs, 'utf8');
  const oldS = String(args.old_string ?? '');
  const newS = String(args.new_string ?? '');
  if (!oldS) return { text: 'edit_file: old_string is empty.', isError: true };
  const count = text.split(oldS).length - 1;
  if (count === 0) return { text: `edit_file: old_string not found in ${args.path}. Read the file and copy the exact text.`, isError: true };
  if (count > 1 && !args.replace_all) return { text: `edit_file: old_string matches ${count} times in ${args.path}. Add surrounding context to make it unique, or set replace_all.`, isError: true };
  const out = args.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, newS);
  fs.writeFileSync(abs, out, 'utf8');
  return { text: `Replaced ${args.replace_all ? count : 1} occurrence${(args.replace_all ? count : 1) === 1 ? '' : 's'} in ${jail.display(abs)}` };
}

function listDirTool(jail, args) {
  const base = jail.resolve(args && args.path);
  const depth = Math.max(1, Math.min(Number(args && args.depth) || 2, 6));
  const out = [];
  for (const f of walkFiles(base, depth)) {
    out.push(jail.display(f.abs) + (f.dir ? path.sep : ''));
    if (out.length >= MAX_ENTRIES) { out.push(`… [capped at ${MAX_ENTRIES} entries — list a subfolder for more]`); break; }
  }
  return { text: out.length ? out.join('\n') : '(empty)' };
}

function grepFilesTool(jail, args) {
  const base = jail.resolve(args && args.path);
  let re;
  try { re = new RegExp(args.pattern); }
  catch { re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
  const ext = args && args.ext ? String(args.ext).replace(/^\./, '').toLowerCase() : null;
  const out = [];
  let scanned = 0;
  for (const f of walkFiles(base, Infinity)) {
    if (f.dir) continue;
    if (ext && !f.abs.toLowerCase().endsWith('.' + ext)) continue;
    let buf;
    try { const st = fs.statSync(f.abs); if (st.size > GREP_FILE_CAP) continue; buf = fs.readFileSync(f.abs); } catch { continue; }
    if (isProbablyBinary(buf)) continue;
    scanned++;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${jail.display(f.abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (out.length >= MAX_MATCHES) {
          out.push(`… [capped at ${MAX_MATCHES} matches — narrow the pattern or path]`);
          return { text: out.join('\n') };
        }
      }
    }
  }
  return { text: out.length ? out.join('\n') : `(no matches in ${scanned} files)` };
}

// Commands do NOT inherit the app's full environment — the Electron process
// env can carry API keys and tokens that no build/test command needs. Only
// this allowlist crosses into the shell (the -l login shell still sources the
// user's own rc files, so PATH managers like nvm keep working).
const SHELL_ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM'];
function shellEnv(extra = {}) {
  const env = {};
  for (const k of SHELL_ENV_ALLOW) if (process.env[k] != null) env[k] = process.env[k];
  // Project build environment (Overview → BUILD ENVIRONMENT): the deliberate
  // way to give builds what they need without inheriting the app's secrets.
  for (const [k, v] of Object.entries(extra || {})) if (v != null) env[k] = String(v);
  return env;
}

function runCommandTool(root, command, timeoutMs, extraEnv) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn('/bin/zsh', ['-lc', command], { cwd: path.resolve(root), env: shellEnv(extraEnv) });
    const add = (chunk) => { if (out.length < MAX_SHELL_OUT) out += chunk.toString('utf8'); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ text: `run_command failed to start: ${e.message}`, isError: true }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (out.length >= MAX_SHELL_OUT) out += '\n… [output truncated]';
      const head = timedOut ? `exit: killed after ${Math.round(timeoutMs / 1000)}s timeout` : `exit ${code}`;
      resolve({ text: `${head}\n${out || '(no output)'}`, isError: timedOut || code !== 0 });
    });
  });
}

/**
 * Build the coding tool pack for one turn.
 * @param {object}   o
 * @param {string}   o.root           the project's working directory (primary root, shell cwd)
 * @param {string}  [o.docsRoot]      the project's documents directory (second allowed root)
 * @param {function} o.approveAction  async ({kind:'write'|'shell', summary}) => boolean —
 *                                    the level-2 gate for mutations (level-3 bypass is
 *                                    decided by the caller inside this callback)
 * @returns {{tools:Array, names:Set<string>, call:function}}
 */
function buildCodingTools({ root, docsRoot, approveAction, buildEnv = {}, projectId = null }) {
  const jail = makeJail([root, docsRoot]);
  const names = new Set(TOOLS.map((t) => t.name));
  const gate = async (kind, summary) =>
    typeof approveAction !== 'function' ? true : !!(await approveAction({ kind, summary }));
  const denied = (what) => ({
    text: `The user declined ${what}. Do not retry it — continue without it or ask the user how to proceed.`,
    isError: true
  });

  async function call(name, args = {}) {
    try {
      switch (name) {
        case 'read_file': return readFileTool(jail, args);
        case 'list_dir': return listDirTool(jail, args);
        case 'grep_files': return grepFilesTool(jail, args);
        case 'write_file': {
          // Scope check BEFORE bothering the user; the approval shows facts —
          // new-vs-overwrite, sizes, a content head — not a bare description.
          const abs = jail.resolve(args.path);
          const content = String(args.content ?? '');
          let facts = `new file, ${content.length} chars`;
          try { const st = fs.statSync(abs); facts = `OVERWRITES ${st.size} bytes → ${content.length} chars`; } catch {}
          const head = content.slice(0, 200).trimEnd();
          const summary = `write_file → ${args.path} (${facts})` + (head ? `\n${head}${content.length > 200 ? '…' : ''}` : '');
          if (!(await gate('write', summary))) return denied('this file write');
          return writeFileTool(jail, args);
        }
        case 'edit_file': {
          // The approval IS the review: show the actual −/+ change, clipped.
          jail.resolve(args.path);
          const dclip = (s) => { const t = String(s ?? ''); return t.length > 400 ? t.slice(0, 400) + '…' : t; };
          const summary = `edit_file → ${args.path}${args.replace_all ? ' (all occurrences)' : ''}\n`
            + dclip(args.old_string).split('\n').map((l) => '- ' + l).join('\n') + '\n'
            + dclip(args.new_string).split('\n').map((l) => '+ ' + l).join('\n');
          if (!(await gate('write', summary))) return denied('this file edit');
          return editFileTool(jail, args);
        }
        case 'run_command': {
          const cmd = String(args.command || '').trim();
          if (!cmd) return { text: 'run_command: no command given.', isError: true };
          if (!(await gate('shell', cmd))) return denied('this shell command');
          const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 60, 1), 300) * 1000;
          return runCommandTool(root, cmd, timeoutMs, buildEnv);
        }
        case 'start_server': {
          const cmd = String(args.command || '').trim();
          if (!cmd) return { text: 'start_server: no command given.', isError: true };
          if (!(await gate('shell', cmd + '   [long-running server]'))) return denied('starting this server');
          const waitMs = Math.min(Math.max(Number(args.wait_seconds) || 12, 1), 60) * 1000;
          const r = await devServer.start({ projectId, root, command: cmd, env: shellEnv(buildEnv), waitMs });
          const head = r.running
            ? `Server running${r.url ? ` at ${r.url}` : ''}${r.ready ? ' (ready)' : ' (still starting)'} — it stays up across turns; stop_server ends it.`
            : `Server exited (code ${r.exitCode})${r.error ? ` — ${r.error}` : ''}.`;
          return { text: `${head}\n\n${r.logs.join('\n') || '(no output yet)'}`, isError: !r.running };
        }
        case 'server_logs': {
          const r = devServer.logs(projectId, Number(args.lines) || 60);
          if (!r.logs.length) return { text: r.running ? '(server running, no output captured yet)' : 'No server is running — start one with start_server.' };
          return { text: `${r.running ? 'running' : 'stopped'}${r.url ? ` · ${r.url}` : ''}\n\n${r.logs.join('\n')}` };
        }
        case 'stop_server': {
          const r = devServer.stop(projectId);
          return { text: r.stopped ? `Stopped: ${r.command}` : 'No server was running.' };
        }
        default: return { text: `unknown coding tool: ${name}`, isError: true };
      }
    } catch (e) {
      return { text: `${name} failed: ${e.message}`, isError: true };
    }
  }

  return { tools: TOOLS, names, call };
}

// ── Documents-mode library pack (O20) ───────────────────────────────────────
// The read-only subset of the coding pack, jailed to the DOCUMENT LIBRARY as
// the single root. Same tool names, same jail machinery, same {text,isError}
// contract — DOCUMENTS mode is the coding harness pattern with different
// hands: no shell, no raw writes (publication goes through save_document).
const LIBRARY_TOOLS = [
  {
    name: 'read_file',
    description:
      'Read a document from the project document library. Paths are the ones shown in the '
      + 'PROJECT LIBRARY listing (relative to the library, or absolute inside it). Optional '
      + 'offset (1-based start line) and limit (line count) for large files.',
    inputSchema: TOOLS.find((t) => t.name === 'read_file').inputSchema
  },
  {
    name: 'list_dir',
    description:
      'List folders and documents in the project document library (recursive, shallow by default).',
    inputSchema: TOOLS.find((t) => t.name === 'list_dir').inputSchema
  },
  {
    name: 'grep_files',
    description:
      'Search document contents in the project library with a regular expression (falls back to '
      + 'a literal search). Returns path:line: text matches.',
    inputSchema: TOOLS.find((t) => t.name === 'grep_files').inputSchema
  }
];

/**
 * Build the documents-mode tool pack: reads jailed to the library root.
 * Reads are level-"free" in the permission hierarchy — no approve callback,
 * because nothing here can mutate. @returns {{tools, names, call}}
 */
function buildLibraryTools({ root }) {
  const jail = makeJail([root]);
  const names = new Set(LIBRARY_TOOLS.map((t) => t.name));
  async function call(name, args = {}) {
    try {
      switch (name) {
        case 'read_file': return readFileTool(jail, args);
        case 'list_dir': return listDirTool(jail, args);
        case 'grep_files': return grepFilesTool(jail, args);
        default: return { text: `unknown library tool: ${name}`, isError: true };
      }
    } catch (e) {
      return { text: `${name} failed: ${e.message}`, isError: true };
    }
  }
  return { tools: LIBRARY_TOOLS, names, call };
}

module.exports = { buildCodingTools, buildLibraryTools, hasGit, initGit, commitStep, CODING_TOOLS: TOOLS, LIBRARY_TOOLS };
