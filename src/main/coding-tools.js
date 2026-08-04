'use strict';

// Coding-harness tool pack: file + shell tools for a chat with coding mode ON.
// Permissions are a HIERARCHY (docs/PLANNING_ARCHITECTURE.md §13c):
//
//   1. Scope — never bypassable. Every file action must resolve inside an
//      allowed root: the project's working directory or its documents
//      directory. Relative paths resolve against the working directory;
//      absolute paths are allowed only when they land inside a root.
//   2. Action gating — reads (read_file, list_dir, grep_files) are free;
//      mutations (write_file, edit_file, run_command) each pause for user
//      approval via the injected approveAction callback.
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
      + 'created as needed. The user approves each write unless they enabled bypass for this '
      + 'project — if a write is declined, continue without it rather than retrying. For small '
      + 'changes to an existing file prefer edit_file.',
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
      + 'true. Read the file first to copy the exact text. The user approves each edit unless they '
      + 'enabled bypass for this project.',
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

// Level 1 — the scope jail. Resolve against the primary root (working dir);
// accept only paths that land inside one of the allowed roots.
function makeJail(roots) {
  const bases = roots.filter(Boolean).map((r) => path.resolve(r));
  const primary = bases[0];
  const inside = (abs) => bases.find((b) => abs === b || abs.startsWith(b + path.sep));
  const resolve = (p) => {
    const abs = path.resolve(primary, String(p == null || p === '' ? '.' : p));
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

function runCommandTool(root, command, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn('/bin/zsh', ['-lc', command], { cwd: path.resolve(root), env: process.env });
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
function buildCodingTools({ root, docsRoot, approveAction }) {
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
          jail.resolve(args.path); // scope check BEFORE bothering the user
          const size = String(args.content ?? '').length;
          if (!(await gate('write', `write_file → ${args.path} (${size} chars)`))) return denied('this file write');
          return writeFileTool(jail, args);
        }
        case 'edit_file': {
          jail.resolve(args.path);
          if (!(await gate('write', `edit_file → ${args.path}`))) return denied('this file edit');
          return editFileTool(jail, args);
        }
        case 'run_command': {
          const cmd = String(args.command || '').trim();
          if (!cmd) return { text: 'run_command: no command given.', isError: true };
          if (!(await gate('shell', cmd))) return denied('this shell command');
          const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 60, 1), 300) * 1000;
          return runCommandTool(root, cmd, timeoutMs);
        }
        default: return { text: `unknown coding tool: ${name}`, isError: true };
      }
    } catch (e) {
      return { text: `${name} failed: ${e.message}`, isError: true };
    }
  }

  return { tools: TOOLS, names, call };
}

module.exports = { buildCodingTools, hasGit, CODING_TOOLS: TOOLS };
