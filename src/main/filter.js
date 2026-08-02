'use strict';

// Our own noise filter for tool results (RTK-inspired) — deterministic, no LLM.
//
// MCP tool output is the biggest token sink after skills (a 74k report, a 300-line
// `git log`, a giant JSON blob). This strips low-signal content BEFORE the result
// re-enters the model's context: ANSI codes, base64/data blobs, pretty-print
// whitespace, duplicate lines, absurdly long lines, and — as a backstop — the
// middle of anything still huge (keeping head AND tail, since summaries/verdicts
// usually live at the end). Every rule that fires is reported for the glass box.

const ANSI = /\[[0-9;]*m/g;
const DATA_URI = /data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g;
const BASE64_BLOB = /[A-Za-z0-9+/]{300,}={0,2}/g;
const LONG_LINE = 2000;

/**
 * @param {string} name  tool name (reserved for per-tool profiles later)
 * @param {string} text  raw tool result
 * @param {object} [opts] { cap = 24000 }
 * @returns {{text:string, before:number, after:number, rules:string[]}}
 */
function filterToolResult(name, text, opts = {}) {
  const cap = opts.cap || 24000;
  const rules = [];
  let out = String(text == null ? '' : text);
  const before = out.length;
  if (!out) return { text: out, before, after: 0, rules };

  // 1. ANSI colour codes
  if (ANSI.test(out)) { out = out.replace(ANSI, ''); rules.push('ansi'); }
  ANSI.lastIndex = 0;

  // 2. data: URIs and long base64 blobs → markers
  if (DATA_URI.test(out)) { out = out.replace(DATA_URI, '[data-uri elided]'); rules.push('data-uri'); }
  DATA_URI.lastIndex = 0;
  out = out.replace(BASE64_BLOB, (m) => { if (!rules.includes('base64')) rules.push('base64'); return `[base64 ${m.length}b elided]`; });

  // 3. JSON → minify (drop pretty-print whitespace losslessly)
  const t = out.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { const min = JSON.stringify(JSON.parse(t)); if (min.length < out.length) { out = min; rules.push('json-min'); } } catch { /* not JSON */ }
  }

  // 4. Trailing whitespace + collapse 3+ blank lines
  const ws = out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  if (ws.length < out.length) { out = ws; rules.push('whitespace'); }

  // 5. Collapse consecutive duplicate lines
  {
    const lines = out.split('\n');
    const dedup = [];
    let run = 0;
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && lines[i] === lines[i - 1] && lines[i].trim()) { run++; continue; }
      if (run > 0) { dedup[dedup.length - 1] = `${lines[i - 1]}  (×${run + 1})`; run = 0; }
      dedup.push(lines[i]);
    }
    if (run > 0) dedup[dedup.length - 1] = `${lines[lines.length - 1]}  (×${run + 1})`;
    const joined = dedup.join('\n');
    if (joined.length < out.length) { out = joined; rules.push('dedup-lines'); }
  }

  // 6. Truncate absurdly long single lines
  {
    let hit = false;
    out = out.split('\n').map((l) => {
      if (l.length > LONG_LINE) { hit = true; return l.slice(0, LONG_LINE) + `…[+${l.length - LONG_LINE} chars]`; }
      return l;
    }).join('\n');
    if (hit) rules.push('long-line');
  }

  // 7. Backstop: still huge → keep head + tail, elide the middle
  if (out.length > cap) {
    const head = out.slice(0, Math.floor(cap * 0.7));
    const tail = out.slice(-Math.floor(cap * 0.2));
    out = head + `\n…[filtered: ${out.length - head.length - tail.length} chars elided from middle]…\n` + tail;
    rules.push('middle-elide');
  }

  return { text: out, before, after: out.length, rules };
}

module.exports = { filterToolResult };
