'use strict';

// Read-time skill normalization. A skill's `definition` column may hold (by
// import vintage): (a) a raw Fluency skills_update DELIVERY ENVELOPE — JSON
// with items[].files[] and the real SKILL.md embedded as a string; (b) a
// SKILL.md with YAML frontmatter; or (c) plain markdown/text. Everything that
// CONSUMES a skill (the selection menu, the planner, the system-prompt
// injection) needs the same three things regardless of vintage: the usable
// instruction BODY, the frontmatter description, and any declared
// mcp_functions. Extracting here — instead of trusting the stored shape —
// makes the whole pipeline resilient to stale imports (verified in
// production: rows imported before parseFluencySkillItems existed held the
// raw envelope, which meant NULL descriptions, a 225k-char JSON blob in the
// system prompt, and a planner reading file manifests instead of procedure).

// Minimal frontmatter reader (same subset as ipc.js's parseFrontmatter: plain
// scalars, folded/literal block scalars, simple lists).
function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md || '');
  if (!m) return { meta: {}, body: md || '' };
  const lines = m[1].split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2];
    if (rest === '>-' || rest === '>' || rest === '|-' || rest === '|') {
      const folded = rest[0] === '>';
      const block = [];
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) { block.push(lines[j].replace(/^\s{2}/, '')); j++; }
      meta[key] = folded ? block.join(' ').trim() : block.join('\n').trim();
      i = j - 1;
    } else if (rest === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const li = /^\s*-\s+(.*)$/.exec(lines[j]);
        if (!li) break;
        items.push(li[1].trim());
        j++;
      }
      if (items.length) { meta[key] = items; i = j - 1; }
    } else {
      meta[key] = rest.trim().replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: m[2] };
}

/**
 * Normalize any stored definition into {body, meta}.
 * - Fluency delivery envelope → the embedded SKILL.md's body + frontmatter meta
 * - frontmattered markdown → body + meta
 * - anything else → as-is, empty meta
 */
function extractSkill(definition) {
  const raw = String(definition || '');
  const t = raw.trimStart();
  if (t.startsWith('{')) {
    try {
      const data = JSON.parse(t);
      const items = data && Array.isArray(data.items) ? data.items : null;
      if (items) {
        const files = (items[0] && Array.isArray(items[0].files)) ? items[0].files : [];
        const file = files.find((f) => /SKILL\.md$/i.test(f.path || '')) || files[0];
        if (file && typeof file.content === 'string') return parseFrontmatter(file.content);
      }
    } catch { /* not an envelope — fall through */ }
  }
  return parseFrontmatter(raw);
}

/**
 * Heal a skill row at read time: fill a missing description from frontmatter,
 * swap the definition for the usable instruction body, and recover a declared
 * tool scope (frontmatter mcp_functions) by suffix-matching against the
 * actually-connected tool names. Leaves explicitly-authored fields alone.
 * @param {object} row       skill row (repo shape; may carry .tools)
 * @param {string[]} [allToolNames] connected tool names (e.g. fluency__get_case)
 * @returns {object} a new row — the stored row is never mutated
 */
function enrichSkillRow(row, allToolNames = []) {
  if (!row) return row;
  const { meta, body } = extractSkill(row.definition);
  const out = { ...row };
  if (body && body !== row.definition) out.definition = body;
  if (!out.description && typeof meta.description === 'string') out.description = meta.description;
  if ((!Array.isArray(out.tools) || !out.tools.length) && Array.isArray(meta.mcp_functions) && meta.mcp_functions.length && allToolNames.length) {
    const matched = meta.mcp_functions
      .map((fn) => allToolNames.find((n) => n === fn || n.endsWith(`__${fn}`)))
      .filter(Boolean);
    if (matched.length) out.tools = matched;
  }
  return out;
}

/**
 * Does a skill have the tools it declares? A skill that names `mcp_functions`
 * and resolves NONE of them cannot do its job, and proceeding anyway is not a
 * degraded run — it is a fabricated one. Measured 2026-08-14: with the Fluency
 * connector returning 401 and zero of nine declared tools resolving, a monthly
 * security report was produced anyway — 54KB, correctly formatted, filed and
 * versioned, and entirely invented, down to named individuals and MTTR to the
 * minute. `enrichSkillRow` already computes this match and silently drops the
 * result when nothing matches; this reports it instead.
 * @returns {{declared:string[], resolved:string[], missing:string[], unmet:boolean}}
 */
function skillPreconditions(row, allToolNames = []) {
  const { meta } = extractSkill(row && row.definition);
  const declared = (Array.isArray(meta.mcp_functions) ? meta.mcp_functions : []).filter((f) => typeof f === 'string' && f.trim());
  const has = (fn) => allToolNames.some((n) => n === fn || n.endsWith(`__${fn}`));
  const resolved = declared.filter(has);
  return {
    declared, resolved,
    missing: declared.filter((fn) => !has(fn)),
    // Partial resolution is a degraded run and allowed. ZERO is the cliff.
    unmet: declared.length > 0 && resolved.length === 0
  };
}

module.exports = { extractSkill, enrichSkillRow, parseFrontmatter, skillPreconditions };
