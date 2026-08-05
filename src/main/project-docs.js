'use strict';

// O15 — the project documents library as the SOURCE OF TRUTH for development.
//
// Claude Code / Codex re-derive a project's objective and purpose by reading
// its code every session. This app inverts that: a canonical doc set lives in
// the project's documents library (real versioned files on disk, indexed in
// the `documents` table), the PLANNER reads it to know intent, and the
// pipeline WRITES it back as things change:
//
//   spec       objectives, requirements, ratified decision records (ADRs)
//   design     architecture, module boundaries, interfaces
//   pseudocode the pipeline/algorithm outlines
//   knowledge  how things actually work — findings, gotchas, contracts
//
// Two write paths:
//   - appendDecisions(): deterministic framework bookkeeping — every ratified
//     align decision (O8 `record`) lands in the SPEC as a dated decision
//     record, versioned via documents.js (same-path resave → .versions/).
//   - the model updates design/knowledge via save_document per the
//     documentation rule in plan-derive.js CODING_RULES (same doc_type +
//     title → same path → version bump, never a pile of new files).

const fs = require('node:fs');
const path = require('node:path');
const repo = require('./db/repo');
const docs = require('./documents');

// Canonical types: doc_type → fixed title (fixed title + type = stable path,
// which is what makes versioning accrete instead of fragmenting).
const CANONICAL = {
  spec: 'SPEC',
  design: 'DESIGN',
  pseudocode: 'PSEUDOCODE',
  knowledge: 'KNOWLEDGE'
};

const SPEC_SKELETON = `# SPEC — Objectives & Requirements

Maintained by the pipeline (HARNESS_OBJECTIVES O15): ratified alignment
decisions append below automatically. Edit freely — the planner reads this
document as the source of truth for what this project is FOR.

## Decision records
`;

const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** Resolve a canonical doc's on-disk location for this project. */
function canonicalPath(outputDir, template, docType) {
  const meta = { type: docType, title: CANONICAL[docType], format: 'md' };
  return { meta, absPath: path.join(outputDir, docs.placementPath(template, meta)) };
}

/**
 * Load the project's canonical docs as one planner-context block.
 * Reads from the indexed rows (path preferred, inline content as fallback).
 * @returns {string} '' when the project has no canonical docs yet.
 */
function load(projectId, clipPer = 8000) {
  let rows = [];
  try { rows = repo.documents.listByProject(projectId); } catch { return ''; }
  const parts = [];
  for (const docType of Object.keys(CANONICAL)) {
    const row = rows.find((r) => r.doc_type === docType);
    if (!row) continue;
    let text = '';
    try { text = row.path && fs.existsSync(row.path) ? fs.readFileSync(row.path, 'utf8') : (row.content || ''); } catch {}
    if (text.trim()) parts.push(`## ${CANONICAL[docType]} (${docType}, v${row.version || 1})\n${clip(text, clipPer)}`);
  }
  return parts.join('\n\n');
}

/**
 * Append ratified decisions to the project SPEC as dated decision records —
 * deterministic bookkeeping on the O8 path, the doc twin of step-commits.
 * Creates the SPEC (skeleton + entries) on first use; versions thereafter.
 * @returns {{absPath, relPath, version, added}}
 */
function appendDecisions({ projectId, outputDir, template, records = [], goal = '' }) {
  const entries = records
    .filter((r) => r && r.key && r.value != null)
    .map((r) => `- ${new Date().toISOString().slice(0, 10)} · **${r.key}** = ${r.value}${goal ? ` — while: ${clip(goal, 120)}` : ''}`);
  if (!entries.length) return { added: 0 };

  const { meta, absPath } = canonicalPath(outputDir, template, 'spec');
  let text = '';
  try { if (fs.existsSync(absPath)) text = fs.readFileSync(absPath, 'utf8'); } catch {}
  if (!text.trim()) text = SPEC_SKELETON;
  if (!/\n$/.test(text)) text += '\n';
  text += entries.join('\n') + '\n';

  const w = docs.writeDocument({ outputDir, template, meta, content: text });
  try {
    repo.documents.saveGenerated({
      projectId, title: CANONICAL.spec, path: w.absPath, mimeType: w.mime,
      source: 'pipeline', docType: 'spec', version: w.version
    });
  } catch (e) { console.error('[project-docs index]', e && e.message); }
  return { absPath: w.absPath, relPath: w.relPath, version: w.version, added: entries.length };
}

module.exports = { load, appendDecisions, CANONICAL, SPEC_SKELETON };
