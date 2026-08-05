'use strict';

// O15 — the project documents library as the SOURCE OF TRUTH for development.
//
// Claude Code / Codex re-derive a project's objective and purpose by reading
// its code every session. This app inverts that: a canonical doc set lives at
// a DESIGNED location in the project's output dir (never the generic
// type-bin), the PLANNER reads it to know intent, and the pipeline WRITES it
// back as things change. Structure (Diátaxis-informed: what/why · structure ·
// outline · how-it-actually-works):
//
//   docs/SPEC.md        objectives · requirements · acceptance criteria ·
//                       decision records (ADRs — pipeline-appended)
//   docs/DESIGN.md      architecture · module map · interfaces
//   docs/PSEUDOCODE.md  per-component outlines
//   docs/KNOWLEDGE.md   how it works · external contracts · gotchas · glossary
//   docs/.versions/     every prior version of each
//
// The set is BOOTSTRAPPED when a project is opened (ensureCanonicalDocs —
// idempotent, heals old projects), so the DOCUMENTS tab always shows the
// project's documentation, not an empty bin awaiting an event.
//
// Write paths:
//   - appendDecisions(): deterministic framework bookkeeping — every ratified
//     align decision (O8 `record`) lands in SPEC as a dated decision record.
//   - writeCanonical(): fixed-path versioned write; save_document calls whose
//     type is canonical route here (ipc.js), so the model's documentation
//     steps update docs/DESIGN.md — never a fresh file in a bin.

const fs = require('node:fs');
const path = require('node:path');
const repo = require('./db/repo');
const docs = require('./documents');

const DOCS_DIRNAME = 'docs';

// Canonical types: doc_type → fixed filename title. Fixed name + fixed dir =
// one stable path per doc, which is what makes versioning accrete.
const CANONICAL = {
  spec: 'SPEC',
  design: 'DESIGN',
  pseudocode: 'PSEUDOCODE',
  knowledge: 'KNOWLEDGE'
};

// Structured skeletons — each states its job and who writes it, so a doc is
// useful scaffolding from minute one instead of an empty page.
const SKELETONS = {
  spec: `# SPEC — Objectives & Requirements

> Source of truth for WHAT this project is for and WHY. The planner reads
> this before every plan. Ratified alignment decisions append below
> automatically (pipeline bookkeeping); edit the rest freely.

## Objectives
<!-- numbered, stable ids: O1, O2 … — commits and design elements cite these -->

## Requirements
<!-- concrete, testable statements -->

## Acceptance criteria
<!-- how we know an objective is met -->

## Decision records
<!-- appended automatically when you ratify an alignment decision -->
`,
  design: `# DESIGN — Architecture & Interfaces

> Source of truth for HOW the project is structured. Updated by the plan's
> documentation step after code or architecture changes — each element should
> cite the SPEC objective it satisfies.

## Architecture overview

## Module map
<!-- module → responsibility → satisfies (O-ids) -->

## Interfaces & contracts
`,
  pseudocode: `# PSEUDOCODE — Component Outlines

> Algorithm/pipeline outlines per component — the shape of the code without
> the code. Updated when flows change.
`,
  knowledge: `# KNOWLEDGE — How It Actually Works

> Findings, gotchas, and external contracts discovered while building —
> the things you only learn the hard way, written down so they're only
> learned once. Updated by the plan's documentation step.

## External contracts
<!-- APIs, data shapes, rate limits observed in the wild -->

## Gotchas & findings

## Glossary
`
};

const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** The one fixed on-disk location for a canonical doc. */
function canonicalPath(outputDir, docType) {
  return path.join(outputDir, DOCS_DIRNAME, `${CANONICAL[docType]}.md`);
}

/** Versioned write to a canonical doc's fixed path + library index row. */
function writeCanonical({ projectId, outputDir, docType, content, source = 'pipeline' }) {
  const absPath = canonicalPath(outputDir, docType);
  const w = docs.writeFileVersioned(absPath, content);
  try {
    repo.documents.saveGenerated({
      projectId, title: CANONICAL[docType], path: w.absPath, mimeType: 'text/markdown',
      source, docType, version: w.version
    });
  } catch (e) { console.error('[project-docs index]', e && e.message); }
  return { absPath: w.absPath, relPath: path.join(DOCS_DIRNAME, `${CANONICAL[docType]}.md`), version: w.version };
}

/**
 * Bootstrap the canonical doc set for a project — create any missing doc from
 * its skeleton and index it. Idempotent: existing docs are never touched.
 * Heals projects created before this structure existed.
 * @returns {string[]} docTypes created this call
 */
function ensureCanonicalDocs({ projectId, outputDir }) {
  const created = [];
  for (const docType of Object.keys(CANONICAL)) {
    const absPath = canonicalPath(outputDir, docType);
    let rows = [];
    try { rows = repo.documents.listByProject(projectId); } catch {}
    const indexed = rows.some((r) => r.doc_type === docType);
    if (fs.existsSync(absPath) && indexed) continue;
    if (!fs.existsSync(absPath)) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, SKELETONS[docType], 'utf8');
      created.push(docType);
    }
    if (!indexed) {
      try {
        repo.documents.saveGenerated({
          projectId, title: CANONICAL[docType], path: absPath, mimeType: 'text/markdown',
          source: 'pipeline', docType, version: 1
        });
      } catch (e) { console.error('[project-docs ensure]', e && e.message); }
    }
  }
  return created;
}

/**
 * Load the project's canonical docs as one planner-context block.
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
 * @returns {{absPath?, relPath?, version?, added}}
 */
function appendDecisions({ projectId, outputDir, records = [], goal = '' }) {
  const entries = records
    .filter((r) => r && r.key && r.value != null)
    .map((r) => `- ${new Date().toISOString().slice(0, 10)} · **${r.key}** = ${r.value}${goal ? ` — while: ${clip(goal, 120)}` : ''}`);
  if (!entries.length) return { added: 0 };

  ensureCanonicalDocs({ projectId, outputDir });
  const absPath = canonicalPath(outputDir, 'spec');
  let text = '';
  try { if (fs.existsSync(absPath)) text = fs.readFileSync(absPath, 'utf8'); } catch {}
  if (!text.trim()) text = SKELETONS.spec;
  if (!/\n$/.test(text)) text += '\n';
  // Decision records live under their own heading — append there when it
  // exists (it does in the skeleton), else at the end.
  text += entries.join('\n') + '\n';

  const w = writeCanonical({ projectId, outputDir, docType: 'spec', content: text });
  return { ...w, added: entries.length };
}

module.exports = { load, appendDecisions, ensureCanonicalDocs, writeCanonical, canonicalPath, CANONICAL, SKELETONS, DOCS_DIRNAME };
