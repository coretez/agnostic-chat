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
const ID_KEY = /(^id$|_id$|Id$|guid$|Guid$|_key$|Key$|_?token$|shortname$|slug$|^path$|_path$|_dir$|^url$|_url$|arn$)/;
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
    const k = String(key).trim();
    if (!k || !isRememberableScalar(value)) return null;
    const confidence = meta.confidence || 'observed';

    const existing = this.entries.get(k);
    if (existing) {
      const sameValue = existing.value === value;
      const newRank = CONFIDENCE_RANK[confidence];
      const oldRank = CONFIDENCE_RANK[existing.confidence];
      // Re-observing the same value at equal-or-lower confidence: no-op, so the
      // store keeps stable capture order and doesn't churn on repeated tool use.
      if (sameValue && newRank <= oldRank) return existing;
      // Lower-confidence contradiction of a higher-confidence value: reject it,
      // but note the attempt in provenance (never silently overwrite a user
      // value with something merely observed in tool traffic).
      if (!sameValue && newRank < oldRank) {
        existing.history.push({ value, source: meta.source || null, seq: this.seq++, rejected: true });
        return existing;
      }
      // Real update (new value, or a confidence upgrade). Only a changed value
      // advances ts — a pure confidence upgrade shouldn't reorder the store.
      if (!sameValue) { existing.history.push({ value: existing.value, source: existing.source, seq: existing.ts }); existing.value = value; existing.ts = this.seq++; }
      existing.type = type || inferType(k, value);
      existing.source = meta.source || existing.source;
      if (meta.step != null) existing.step = meta.step;
      existing.confidence = confidence;
      return existing;
    }

    const entry = {
      key: k, value, type: type || inferType(k, value),
      source: meta.source || null, step: meta.step != null ? meta.step : null,
      confidence, ts: this.seq++, history: []
    };
    this.entries.set(k, entry);
    this._evict();
    return entry;
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
    let data;
    try { data = JSON.parse(String(text)); } catch { return []; }
    const found = [];
    const scan = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 2 || found.length >= MAX_RESULT_CAPTURES) return;
      if (Array.isArray(obj)) { if (obj.length) scan(obj[0], depth + 1); return; }
      for (const [k, v] of Object.entries(obj)) {
        if (found.length >= MAX_RESULT_CAPTURES) return;
        if (isRememberableScalar(v) && isCapturableKey(k)) found.push([k, v]);
        else if (v && typeof v === 'object') scan(v, depth + 1);
      }
    };
    scan(data, 0);
    const out = [];
    for (const [k, v] of found) {
      const e = this.set({ key: k, value: v }, {
        confidence: 'observed', step: meta.step,
        source: toolName ? `${toolName}#result` : 'result'
      });
      if (e) out.push(e);
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
  description: 'Record a value in working memory so later steps and tool calls can reuse it. Use for identifiers, paths, or derived values you will need again (e.g. a tenant id, a case id, a report file path).',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short, stable name for the value, e.g. tenant_id, case_id, report_path.' },
      value: { type: 'string', description: 'The value to remember.' },
      type: { type: 'string', enum: ['string', 'number', 'id', 'path', 'json'], description: 'Optional kind of value.' }
    },
    required: ['key', 'value']
  }
};

module.exports = { VariableStore, SET_VARIABLE_TOOL };
