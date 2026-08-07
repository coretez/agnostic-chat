'use strict';

// Common variables for CODING work — the coding-mode twin of the MCP capture
// rules in variables.js.
//
// variables.js harvests ids/locators from MCP calls (case_id, tenant, paths).
// A coding turn produces a different family of durable facts: the dev server's
// URL and port, the commands that build/test/run this project, the package
// manager, the framework. Those were only ever captured if the model
// remembered to call set_variable — so the next turn re-derived "how do I run
// the tests" from scratch.
//
// This module captures them DETERMINISTICALLY from what the tools actually
// did (observed confidence, so a user-stated value always outranks them), and
// they persist in the same store, ride the same KNOWN VALUES block, and appear
// in the same UI as every other variable.

// Command shapes worth remembering, in priority order. Each maps a matched
// command to the variable it establishes.
const COMMAND_FACTS = [
  { key: 'test_command', re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b.*|^(?:pytest|go test|cargo test|mix test|rspec|jest|vitest)\b.*/i },
  { key: 'build_command', re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b.*|^(?:make|cargo build|go build|mvn package|gradle build)\b.*/i },
  { key: 'lint_command', re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b.*|^(?:eslint|ruff|flake8|golangci-lint)\b.*/i },
  { key: 'install_command', re: /^(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add)\b.*|^(?:pip install|poetry install|bundle install|cargo fetch)\b.*/i }
];

const PKG_MANAGER = /^(npm|pnpm|yarn|bun)\b/i;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?\S*/i;

const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 200);

/**
 * Derive coding facts from one tool call.
 * @param {string} name    tool name
 * @param {object} args    tool arguments
 * @param {string} text    tool result text ('' when unavailable)
 * @param {boolean} ok     the call succeeded
 * @returns {Array<{key,value}>} facts to record (may be empty)
 */
function factsFromCall(name, args = {}, text = '', ok = true) {
  const out = [];
  const push = (key, value) => { const v = clean(value); if (v) out.push({ key, value: v }); };

  if (name === 'start_server') {
    const cmd = clean(args.command);
    if (cmd) push('dev_command', cmd);
    const m = String(text || '').match(URL_RE);
    // Only record a URL the server actually reported — a failed start must not
    // leave a stale "the site runs here" fact behind.
    if (ok && m) { push('dev_server_url', m[0]); if (m[1]) push('dev_server_port', m[1]); }
    if (cmd && PKG_MANAGER.test(cmd)) push('package_manager', cmd.match(PKG_MANAGER)[1].toLowerCase());
    return out;
  }

  if (name === 'stop_server') return out;   // the URL stays valid as "how to run it"

  if (name === 'run_command') {
    const cmd = clean(args.command);
    if (!cmd || !ok) return out;            // a failing command is not the way to do it
    for (const f of COMMAND_FACTS) {
      if (f.re.test(cmd)) { push(f.key, cmd); break; }
    }
    if (PKG_MANAGER.test(cmd)) push('package_manager', cmd.match(PKG_MANAGER)[1].toLowerCase());
    return out;
  }

  return out;
}

/**
 * Record derived facts into the shared VariableStore at `observed` confidence
 * (user-stated values outrank them; re-observation is a no-op).
 * @returns {string[]} keys newly set or changed
 */
function capture(store, { name, args, text, ok = true, step } = {}) {
  if (!store || typeof store.set !== 'function') return [];
  const changed = [];
  for (const f of factsFromCall(name, args, text, ok)) {
    // store.get() returns the VALUE (not the entry) — compare directly so an
    // unchanged re-observation doesn't narrate itself every turn.
    const before = typeof store.get === 'function' ? store.get(f.key) : undefined;
    const entry = store.set({ key: f.key, value: f.value }, { confidence: 'observed', source: name, step });
    if (entry && before !== entry.value) changed.push(entry.key);
  }
  return changed;
}

module.exports = { capture, factsFromCall, COMMAND_FACTS };
