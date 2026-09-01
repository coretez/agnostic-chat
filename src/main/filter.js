'use strict';

// Our own noise filter for tool results (RTK-inspired) — deterministic, no LLM.
//
// MCP tool output is the biggest token sink after skills (a 74k report, a 300-line
// `git log`, a giant JSON blob). This strips low-signal content BEFORE the result
// re-enters the model's context: ANSI codes, base64/data blobs, pretty-print
// whitespace, duplicate lines, absurdly long lines, and — as a backstop — the
// middle of anything still huge (keeping head AND tail, since summaries/verdicts
// usually live at the end). Every rule that fires is reported for the glass box.

const ANSI = /\x1b\[[0-9;]*m/g;
const DATA_URI = /data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g;
const BASE64_BLOB = /[A-Za-z0-9+/]{300,}={0,2}/g;
const LONG_LINE = 2000;

const CASE_RANKING_KEY = /(case.?id|\bid\b|risk|score|status|owner|assignee|severity|priority|entity|asset|user|behavior|classification|incident|fingerprint|signature|description|summary|created|updated|first|last|time|date|day)/i;

function compactNested(value, depth = 0) {
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + `…[+${value.length - 500} chars]` : value;
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 2) return Array.isArray(value) ? `[${value.length} nested items]` : '[nested object]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => compactNested(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = compactNested(v, depth + 1);
  return out;
}

function compactCaseRow(row, rankingOnly = false) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return compactNested(row);
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (rankingOnly && !CASE_RANKING_KEY.test(k)) continue;
    out[k] = compactNested(v);
  }
  return out;
}

function findCaseArray(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  for (const key of ['cases', 'rows', 'results', 'items']) {
    if (Array.isArray(node[key]) && node[key].some((v) => v && typeof v === 'object')) return { owner: node, key };
  }
  for (const v of Object.values(node)) {
    const found = findCaseArray(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// Preserve every case row and its ranking fields in valid JSON. Verbose AI
// narratives and nested evidence can otherwise push rows 3..20 past a generic
// character cut, making a top-five ranking impossible.
function compactCaseList(parsed, cap) {
  const found = findCaseArray(parsed);
  if (!found) return null;
  const original = found.owner[found.key];
  found.owner[found.key] = original.map((row) => compactCaseRow(row, false));
  found.owner._filter_note = `All ${original.length} case rows preserved; long narrative and nested values compacted.`;
  let rendered = JSON.stringify(parsed);
  if (rendered.length <= cap) return rendered;
  found.owner[found.key] = original.map((row) => compactCaseRow(row, true));
  found.owner._filter_note = `All ${original.length} case rows preserved with ranking/evidence fields; verbose fields omitted.`;
  rendered = JSON.stringify(parsed);
  return rendered;
}

// Epoch-millisecond timestamps, rendered as ISO 8601.
//
// Two reasons, one of them found the hard way. The soft one: a model reasons
// about "2026-08-14T10:28:00Z" and cannot reason about 1785304080000, so every
// timeline question over raw epochs is answered by guesswork.
//
// The hard one: a 13-digit epoch has roughly a 1-in-10 chance of passing the
// Luhn checksum, and Presidio's credit-card recognizer is exactly a 13-19 digit
// Luhn check. Fluency case records are full of epoch-millis, so an LLM firewall
// with a PII policy blocks SOC investigations at random — with a confidence of
// 1.0, on a credit-card rule, over a timestamp. No threshold can separate those;
// the fix is to stop putting bare epochs on the wire.
//
// The window is 2015-01-01 .. 2035-01-01, which keeps this from rewriting
// arbitrary 13-digit identifiers, and cannot collide with a 13-digit card
// number (those begin with 4, an order of magnitude above the range).
const EPOCH_MS = /\b(1[4-9]\d{11}|20[0-4]\d{10})\b/g;
const EPOCH_MS_MIN = Date.UTC(2015, 0, 1);
const EPOCH_MS_MAX = Date.UTC(2035, 0, 1);

/** An epoch-millis value as ISO 8601, or null if it is not one. */
function isoFromEpochMs(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < EPOCH_MS_MIN || n > EPOCH_MS_MAX) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Every epoch-millis token inside a string, converted in place. */
function convertEpochsInText(text, hit) {
  return text.replace(EPOCH_MS, (m) => {
    const iso = isoFromEpochMs(m);
    if (!iso) return m;
    hit.n += 1;
    return iso;
  });
}

/**
 * Convert epoch-millis in a PARSED structure, so a number stays a JSON value
 * and becomes a quoted string rather than a bare token that breaks the parse.
 *
 * Strings are scanned rather than matched whole: MCP servers routinely return
 * a CSV or log blob as ONE JSON string field, and a whole-string test walks
 * straight past every timestamp inside it. That is exactly how a real Expo
 * monthly report still tripped the credit-card rule after the first fix.
 *
 * Returns the converted tree; `hit.n` counts conversions.
 */
function convertEpochsDeep(node, hit) {
  if (typeof node === 'number') { const iso = isoFromEpochMs(node); if (iso) { hit.n += 1; return iso; } return node; }
  if (typeof node === 'string') return convertEpochsInText(node, hit);
  if (Array.isArray(node)) return node.map((v) => convertEpochsDeep(v, hit));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = convertEpochsDeep(v, hit);
    return out;
  }
  return node;
}

/**
 * @param {string} name  tool name (reserved for per-tool profiles later)
 * @param {string} text  raw tool result
 * @param {object} [opts] { cap = 24000 }
 * @returns {{text:string, before:number, after:number, rules:string[]}}
 */
function removeEncodedNoise(state) {
  if (ANSI.test(state.text)) { state.text = state.text.replace(ANSI, ''); state.rules.push('ansi'); }
  ANSI.lastIndex = 0;
  if (DATA_URI.test(state.text)) { state.text = state.text.replace(DATA_URI, '[data-uri elided]'); state.rules.push('data-uri'); }
  DATA_URI.lastIndex = 0;
  state.text = state.text.replace(BASE64_BLOB, (match) => {
    if (!state.rules.includes('base64')) state.rules.push('base64');
    return `[base64 ${match.length}b elided]`;
  });
}

function normalizeJsonResult(state, name, cap) {
  const trimmed = state.text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
  try {
    const hit = { n: 0 };
    const parsed = convertEpochsDeep(JSON.parse(trimmed), hit);
    let rendered = JSON.stringify(parsed);
    if (/(^|__)list_cases$/i.test(String(name || '')) && rendered.length > cap) {
      const compact = compactCaseList(parsed, cap);
      if (compact) { rendered = compact; state.rules.push('case-list-compact'); }
    }
    state.wasJson = true;
    if (hit.n) state.rules.push('epoch-iso');
    if (rendered.length < state.text.length || hit.n || state.rules.includes('case-list-compact')) {
      state.text = rendered;
      if (!state.rules.includes('json-min')) state.rules.push('json-min');
    }
  } catch {}
}

function normalizeFreeTextEpochs(state) {
  if (state.wasJson) return;
  const hit = { n: 0 };
  state.text = convertEpochsInText(state.text, hit);
  if (hit.n && !state.rules.includes('epoch-iso')) state.rules.push('epoch-iso');
}

function normalizeWhitespace(state) {
  const normalized = state.text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  if (normalized.length < state.text.length) state.rules.push('whitespace');
  state.text = normalized;
}

function collapseDuplicateLines(state) {
  if (state.wasJson) return;
  const lines = state.text.split('\n');
  const deduplicated = [];
  let repetitions = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0 && lines[index] === lines[index - 1] && lines[index].trim()) { repetitions += 1; continue; }
    if (repetitions > 0) { deduplicated[deduplicated.length - 1] = `${lines[index - 1]}  (×${repetitions + 1})`; repetitions = 0; }
    deduplicated.push(lines[index]);
  }
  if (repetitions > 0) deduplicated[deduplicated.length - 1] = `${lines[lines.length - 1]}  (×${repetitions + 1})`;
  const joined = deduplicated.join('\n');
  if (joined.length < state.text.length) state.rules.push('dedup-lines');
  state.text = joined;
}

function truncateLongLines(state) {
  if (state.wasJson) return;
  let changed = false;
  state.text = state.text.split('\n').map((line) => {
    if (line.length <= LONG_LINE) return line;
    changed = true;
    return line.slice(0, LONG_LINE) + `…[+${line.length - LONG_LINE} chars]`;
  }).join('\n');
  if (changed) state.rules.push('long-line');
}

function enforceResultCap(state, cap) {
  if (state.text.length <= cap) return;
  if (state.wasJson && state.rules.includes('case-list-compact')) {
    state.rules.push('valid-json-over-cap');
    return;
  }
  const head = state.text.slice(0, Math.floor(cap * 0.7));
  const tail = state.text.slice(-Math.floor(cap * 0.2));
  state.text = head + `\n…[filtered: ${state.text.length - head.length - tail.length} chars elided from middle]…\n` + tail;
  state.rules.push('middle-elide');
}

function filterToolResult(name, text, opts = {}) {
  const cap = opts.cap || 24000;
  const originalText = String(text == null ? '' : text);
  const state = { text: originalText, rules: [], wasJson: false };
  if (!state.text) return { text: '', before: 0, after: 0, rules: [] };
  removeEncodedNoise(state);
  normalizeJsonResult(state, name, cap);
  normalizeFreeTextEpochs(state);
  normalizeWhitespace(state);
  collapseDuplicateLines(state);
  truncateLongLines(state);
  enforceResultCap(state, cap);
  return { text: state.text, before: originalText.length, after: state.text.length, rules: state.rules };
}

module.exports = { filterToolResult, compactCaseList };
