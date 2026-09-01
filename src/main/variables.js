'use strict';

// Variable Store — working memory of discovered tool parameters and derived
// values, carried across the steps of a turn and (via chats.variables_json)
// across the turns of a chat. This is the piece that lets step N form a tool
// call from a value step N-1 discovered, and the piece compaction must never
// drop. See the internal planning-architecture record §5.
//
// Ordering uses a turn-relative sequence counter (`seq`), never wall-clock —
// deterministic and test-reproducible (a project constraint). `seq` persists
// with the store so ordering is stable across save/load.

const MAX_ENTRIES = 64;          // store cap; least-valuable entry evicted past this
const MAX_VALUE_LEN = 200;       // longer strings are content/blobs, not parameters
const MAX_RESULT_CAPTURES = 8;   // id-like values harvested from a single tool result

// Higher = more authoritative. A user-stated value outranks a model-derived one,
// which outranks a value merely observed in tool traffic. Governs both
// overwrite-protection and eviction order.
const CONFIDENCE_RANK = { observed: 1, derived: 2, user: 3 };

// Keys whose scalar values are worth auto-remembering as reusable parameters:
// identifier/locator shapes (…_id, guid, path, url, token, slug) plus a small
// set of common domain parameters. Everything else the model must record
// deliberately via set_variable — this keeps auto-capture from hoarding noise
// like `limit` or `query`.
const ID_KEY = /(^id$|_id$|Id$|guid$|Guid$|_key$|Key$|_?token$|shortname$|slug$|^path$|_path$|_dir$|^url$|_url$|arn$|_hash$|Hash$)/;
const COMMON_PARAM = /^(tenant|tenant_id|account|account_id|case|case_id|company|org|organization|region|host|hostname|domain|email|user|username|project|project_id|bucket|repo|branch|framework|period)$/i;

function isCapturableKey(key) {
  return ID_KEY.test(key) || COMMON_PARAM.test(key);
}

function inferType(key, value) {
  if (typeof value === 'number') return 'number';
  const s = String(value);
  if (/[/\\]/.test(s) && !/\s/.test(s)) return 'path';
  if (ID_KEY.test(key) || COMMON_PARAM.test(key)) return 'id';
  return 'string';
}

// A remember-able scalar is a non-empty short string or a finite number. Objects,
// arrays, booleans, null, and long blobs are rejected — the store holds flat,
// reusable parameters, not content.
function isRememberableScalar(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') { const t = v.trim(); return t.length >= 1 && t.length <= MAX_VALUE_LEN; }
  return false;
}

function updateExistingEntry(store, entry, key, value, type, meta, confidence) {
  const sameValue = entry.value === value;
  const newRank = CONFIDENCE_RANK[confidence];
  const oldRank = CONFIDENCE_RANK[entry.confidence];
  if (sameValue && newRank <= oldRank) return entry;
  if (!sameValue && newRank < oldRank) {
    entry.history.push({ value, source: meta.source || null, seq: store.seq++, rejected: true });
    return entry;
  }
  if (!sameValue) {
    entry.history.push({ value: entry.value, source: entry.source, seq: entry.ts });
    entry.value = value; entry.ts = store.seq++;
  }
  entry.type = type || inferType(key, value);
  entry.source = meta.source || entry.source;
  if (meta.step != null) entry.step = meta.step;
  entry.confidence = confidence;
  return entry;
}

function createEntry(store, key, value, type, meta, confidence) {
  const entry = {
    key, value, type: type || inferType(key, value), source: meta.source || null,
    step: meta.step != null ? meta.step : null, confidence, ts: store.seq++, history: []
  };
  store.entries.set(key, entry);
  store._evict();
  return entry;
}

function parseResultJson(text) {
  const source = String(text);
  try { return JSON.parse(source); } catch {}
  const fences = [...source.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(fences[index][1]); } catch {}
  }
  return undefined;
}

function scanCapturableValues(value, found = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2 || found.length >= MAX_RESULT_CAPTURES) return found;
  if (Array.isArray(value)) return value.length ? scanCapturableValues(value[0], found, depth + 1) : found;
  for (const [key, child] of Object.entries(value)) {
    if (found.length >= MAX_RESULT_CAPTURES) break;
    if (isRememberableScalar(child) && isCapturableKey(key)) found.push([key, child]);
    else if (child && typeof child === 'object') scanCapturableValues(child, found, depth + 1);
  }
  return found;
}

class VariableStore {
  constructor() {
    this.entries = new Map();  // key -> entry
    this.seq = 0;              // turn-relative monotonic clock (NOT wall-clock)
  }

  /**
   * Record (or update) a value.
   * @param {{key:string, value:(string|number), type?:string}} v
   * @param {{confidence?:string, source?:string, step?:number}} [meta]
   * @returns {object|null} the entry, or null if the input wasn't storable
   */
  set({ key, value, type } = {}, meta = {}) {
    if (key == null || value == null) return null;
    const normalizedKey = String(key).trim();
    if (!normalizedKey || !isRememberableScalar(value)) return null;
    const confidence = meta.confidence || 'observed';
    const existing = this.entries.get(normalizedKey);
    return existing
      ? updateExistingEntry(this, existing, normalizedKey, value, type, meta, confidence)
      : createEntry(this, normalizedKey, value, type, meta, confidence);
  }

  /** Drop the least-valuable entries (lowest confidence, then oldest) past the cap. */
  _evict() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const ranked = [...this.entries.values()].sort(
      (a, b) => (CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]) || (a.ts - b.ts)
    );
    while (this.entries.size > MAX_ENTRIES && ranked.length) {
      this.entries.delete(ranked.shift().key);
    }
  }

  get(key) { const e = this.entries.get(String(key)); return e ? e.value : undefined; }
  has(key) { return this.entries.has(String(key)); }
  get size() { return this.entries.size; }

  /** Entries in stable capture order (by turn-relative seq). */
  list() { return [...this.entries.values()].sort((a, b) => a.ts - b.ts); }

  /**
   * Auto-capture reusable parameters the model actually USED in a tool call.
   * A resolved argument is, by definition, a value worth remembering — but only
   * for identifier/locator-shaped keys, to avoid hoarding generic knobs.
   */
  captureFromArgs(args, meta = {}) {
    if (!args || typeof args !== 'object') return [];
    const out = [];
    for (const [k, v] of Object.entries(args)) {
      if (!isCapturableKey(k) || !isRememberableScalar(v)) continue;
      const e = this.set({ key: k, value: v }, {
        confidence: 'observed', step: meta.step,
        source: meta.source ? `${meta.source}#args` : 'args'
      });
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * Auto-capture obvious id/path/key values from a tool RESULT. Only fires when
   * the result parses as JSON; scans shallowly (≤2 levels, first array element)
   * for identifier-shaped keys, capped so a big list can't flood the store.
   */
  captureFromResult(toolName, text, meta = {}) {
    const data = parseResultJson(text);
    if (data === undefined) return [];
    const out = [];
    for (const [key, value] of scanCapturableValues(data)) {
      const entry = this.set({ key, value }, {
        confidence: 'observed', step: meta.step,
        source: toolName ? `${toolName}#result` : 'result'
      });
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Render as the always-present "KNOWN VALUES" block injected into the prompt
   * (instruction layer 5). Empty string when there's nothing to show, so the
   * caller can omit the layer entirely.
   */
  render() {
    const list = this.list();
    if (!list.length) return '';
    const lines = list.map((e) => {
      const val = e.type === 'number' ? e.value : `"${e.value}"`;
      const prov = [e.source, e.step != null ? `step ${e.step}` : null].filter(Boolean).join(', ');
      return `- ${e.key} = ${val}${prov ? `  (${prov})` : ''}`;
    });
    return `KNOWN VALUES (use these exact values when a tool needs them):\n${lines.join('\n')}`;
  }

  /** Serializable snapshot for chats.variables_json. */
  toJSON() { return { seq: this.seq, entries: this.list() }; }

  /** Rebuild a store from a snapshot (object or JSON string); tolerant of junk. */
  static fromJSON(json) {
    const store = new VariableStore();
    if (!json) return store;
    let obj = json;
    if (typeof json === 'string') { try { obj = JSON.parse(json); } catch { return store; } }
    if (!obj || typeof obj !== 'object') return store;
    store.seq = Number(obj.seq) || 0;
    for (const e of (Array.isArray(obj.entries) ? obj.entries : [])) {
      if (!e || e.key == null) continue;
      const k = String(e.key);
      store.entries.set(k, {
        key: k, value: e.value, type: e.type || 'string',
        source: e.source || null, step: e.step != null ? e.step : null,
        confidence: CONFIDENCE_RANK[e.confidence] ? e.confidence : 'observed',
        ts: e.ts != null ? e.ts : store.seq++,
        history: Array.isArray(e.history) ? e.history : []
      });
    }
    // Guard against a persisted seq that trails the max entry ts (would cause
    // ordering collisions on the next set()).
    for (const e of store.entries.values()) if (e.ts >= store.seq) store.seq = e.ts + 1;
    return store;
  }
}

// Synthetic tool the model calls to record a value deliberately (the explicit
// half of the "both" capture mechanism). Wired into a step's tool list by the
// executor; intercepted before it reaches the MCP router.
const SET_VARIABLE_TOOL = {
  name: 'set_variable',
  description: 'Record ONE short scalar in working memory so later tool calls can reuse it. Use only for identifiers, paths, numbers, or short strings (e.g. tenant id, case id, report path). Never use this for objects, arrays, evidence bundles, drafts, plans, or prose; step conclusions are passed automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short, stable name for the value, e.g. tenant_id, case_id, report_path.' },
      value: { type: 'string', description: 'The value to remember.' },
      type: { type: 'string', enum: ['string', 'number', 'id', 'path'], description: 'Optional scalar kind.' }
    },
    required: ['key', 'value']
  }
};

module.exports = { VariableStore, SET_VARIABLE_TOOL };
