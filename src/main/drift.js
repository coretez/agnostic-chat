'use strict';

// O30 — the drift pass: backward-looking garbage collection. Per-turn review
// (O11) sees one turn; drift is a CROSS-TURN phenomenon — agents replicate
// whatever patterns exist, so deviation compounds silently unless something
// looks backward. This pass scans the most recently modified source files
// against the project rulebook (O29) and canonical docs (O15), plus the docs
// themselves for staleness, and reports findings for the DEBT ledger (O27).
// Read-only: it never mutates the tree — fixes run later as ordinary bounded
// plans with ordinary gates. User-invoked (Overview → MAINTENANCE).

const fs = require('node:fs');
const path = require('node:path');
const { SUBMIT_REVIEW_TOOL } = require('./review');

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.rb', '.java', '.swift', '.kt', '.c', '.h', '.cpp', '.cs', '.sql', '.css', '.html']);
const MAX_FILES = 8;
const MAX_FILE_CHARS = 6000;
const DOC_NAMES = ['SPEC.md', 'DESIGN.md', 'PSEUDOCODE.md', 'KNOWLEDGE.md'];

const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; };

/** The most recently modified source files from a list_dir listing. */
function recentSourceFiles(listText, root) {
  const rels = String(listText || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith(path.sep) && CODE_EXT.has(path.extname(l)));
  const mtime = (rel) => { try { return fs.statSync(path.join(root, rel)).mtimeMs; } catch { return 0; } };
  return rels.map((rel) => ({ rel, m: mtime(rel) }))
    .sort((a, b) => b.m - a.m)
    .slice(0, MAX_FILES)
    .map((f) => f.rel);
}

const DRIFT_PROMPT = ({ rulebook, docsBlock, files }) =>
`You are an architectural-drift reviewer doing a scheduled maintenance pass — not reviewing one change, but looking for what has DRIFTED across recent work.

Judge the files below against the project's rulebook and canonical docs. Report only REAL deviations, at most 6; an empty list is a good outcome, never pad:
- rulebook violations (the rules below are non-negotiable for this repository)
- pattern drift: the same job done two different ways, hand-rolled helpers where a shared one exists, module boundaries crossed
- doc staleness: a canonical doc (SPEC/DESIGN/PSEUDOCODE/KNOWLEDGE) contradicting what the code actually does — file the finding against the doc's name
- DIAGRAM staleness: entries below whose path is a .md file are DIAGRAMS extracted from that doc. Check every node and edge against the code above: a step, gate, or branch the code performs but the diagram omits is a finding, and so is one the diagram shows that the code no longer does. Diagrams rot silently because nothing compiles them.

${rulebook ? `PROJECT RULEBOOK:\n${clip(rulebook, 5000)}\n\n` : ''}${docsBlock ? `CANONICAL DOCS:\n${clip(docsBlock, 6000)}\n\n` : ''}RECENTLY MODIFIED SOURCE FILES:
${files.map((f) => `### ${f.path}\n\`\`\`\n${clip(f.content, MAX_FILE_CHARS)}\n\`\`\``).join('\n\n')}

Call submit_review now.`;

function validateFindings(raw, knownFiles) {
  const known = new Set([...knownFiles, ...DOC_NAMES]);
  const out = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!f || typeof f.issue !== 'string' || !f.issue.trim() || !known.has(f.file)) continue;
    const sev = String(f.severity || 'med').toLowerCase();
    out.push({ lens: 'drift', severity: sev === 'high' ? 'high' : 'med', file: f.file, issue: f.issue.trim(), fix: clip(String(f.fix || '').trim(), 300) });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Fenced diagram blocks inside the canonical docs, as scannable entries.
 * A stale mermaid flowchart contradicting the code was the rot that motivated
 * this pass, and the pass could not see it: doc PROSE is compared against the
 * code, but a diagram embedded in a doc was never in the scan set.
 * @returns {Array<{path,content}>}
 */
function docDiagrams(docsDir) {
  const out = [];
  for (const name of DOC_NAMES) {
    let text = '';
    try { text = fs.readFileSync(path.join(docsDir, name), 'utf8'); } catch { continue; }
    const blocks = text.match(/```(?:mermaid|graphviz|dot)\n[\s\S]*?```/g) || [];
    if (blocks.length) out.push({ path: name, content: blocks.join('\n\n').slice(0, MAX_FILE_CHARS) });
  }
  return out;
}

async function readScanFiles(coding, root, onEvent) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const map = await coding.call('list_dir', { depth: 3 });
  const rels = recentSourceFiles(map.text, root);
  const files = [];
  for (const rel of rels) {
    const r = await coding.call('read_file', { path: rel });
    if (!r.isError) files.push({ path: rel, content: String(r.text || '') });
  }
  const diagrams = docDiagrams(path.join(root, 'docs'));
  emit({ type: 'process', kind: 'drift-scan', files: files.length, diagrams: diagrams.length });
  return [...files, ...diagrams];
}

/**
 * Scan for drift. Read-only; any failure returns {findings: []} — the pass
 * can never break anything, only report.
 * @returns {Promise<{findings:Array, scanned:number, error?:string}>}
 */
async function driftScan({ connector, model, coding, root, rulebook = '', docsBlock = '', onEvent }) {
  try {
    const files = await readScanFiles(coding, root, onEvent);
    if (!files.length) return { findings: [], scanned: 0 };
    const messages = [{ role: 'user', content: DRIFT_PROMPT({ rulebook, docsBlock, files }) }];
    let r;
    try { r = await connector.chat({ model, messages, tools: [SUBMIT_REVIEW_TOOL], forceTool: true, maxTokens: 3000 }); }
    catch { r = await connector.chat({ model, messages, tools: [SUBMIT_REVIEW_TOOL], maxTokens: 3000 }); }
    const call = (r.toolCalls || [])[0];
    const args = call && call.args && typeof call.args === 'object' ? call.args : {};
    const findings = args.clean ? [] : validateFindings(args.findings, files.map((f) => f.path));
    return { findings, scanned: files.length };
  } catch (e) {
    return { findings: [], scanned: 0, error: e && e.message };
  }
}

module.exports = { driftScan, recentSourceFiles, docDiagrams, DRIFT_PROMPT };
