'use strict';

// A turn is an evidence snapshot. Re-running the same read-only MCP call later
// in that turn is both expensive and, for live systems, capable of producing a
// different answer from the one earlier steps used. Keep one successful result
// per exact tool+argument pair. Mutations and ambiguous tools always pass
// through; MCP's readOnlyHint wins when a server supplies it, with a conservative
// name fallback for older servers that do not publish annotations yet.

const READ_ONLY_PREFIX = /^(analyze|calculate|check|compare|describe|fetch|find|get|inspect|investigate|list|lookup|preview|query|read|report|resolve|search|summarize|validate)(?:_|$)/i;

function stableValue(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError('circular tool arguments');
  seen.add(value);
  let out;
  if (Array.isArray(value)) out = `[${value.map((v) => stableValue(v, seen)).join(',')}]`;
  else out = `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableValue(value[k], seen)}`).join(',')}}`;
  seen.delete(value);
  return out;
}

function originalName(namespaced) {
  const i = String(namespaced || '').lastIndexOf('__');
  return i >= 0 ? String(namespaced).slice(i + 2) : '';
}

function isReadOnlyMcpTool(name, tools = []) {
  const original = originalName(name);
  if (!original) return false; // local/document/web tools are not inferred
  const declared = tools.find((t) => t && t.name === name);
  if (declared && declared.annotations && declared.annotations.readOnlyHint === true) return true;
  if (declared && declared.annotations && declared.annotations.readOnlyHint === false) return false;
  return READ_ONLY_PREFIX.test(original);
}

function cacheKey(name, args) {
  try { return `${name}\n${stableValue(args == null ? {} : args)}`; }
  catch { return null; }
}

class TurnToolCache {
  constructor(tools = [], onHit = () => {}) {
    this.tools = tools;
    this.onHit = onHit;
    this.entries = new Map();
  }

  async call(name, args, invoke) {
    if (!isReadOnlyMcpTool(name, this.tools)) return invoke();
    const key = cacheKey(name, args);
    if (!key) return invoke();
    if (this.entries.has(key)) {
      this.onHit(name);
      return this.entries.get(key);
    }
    const pending = Promise.resolve().then(invoke);
    this.entries.set(key, pending);
    try {
      const result = await pending;
      if (result && result.isError) this.entries.delete(key);
      return result;
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }
}

module.exports = { TurnToolCache, isReadOnlyMcpTool, cacheKey };
