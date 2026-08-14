'use strict';

// O15 — the documentation writer: a dedicated technical-writer pass that runs
// AFTER a coding turn's execution, deterministically (framework bookkeeping,
// like step-commits and decision records — never a plan step the model may
// fumble; that approach produced untouched skeletons and narrative sludge).
//
// One fast-model call: current docs + what actually happened (files touched,
// step results, known values) in → full replacement markdown out, per doc,
// ONLY for docs the change genuinely affects. Strict tech-writer standards in
// the prompt; light validation here; the caller (ipc.js) writes via
// project-docs.writeCanonical so everything versions at the fixed paths.

const { WRITING_TOOLS } = require('./coding-tools');

const SUBMIT_DOCS_TOOL = {
  name: 'submit_docs',
  description: 'Return the updated project documentation. Include ONLY documents this change genuinely affects, as full replacement markdown. Set none=true when nothing warrants an update.',
  inputSchema: {
    type: 'object',
    properties: {
      design: { type: 'string', description: 'FULL replacement markdown for DESIGN.md — only if architecture, modules, or interfaces changed.' },
      pseudocode: { type: 'string', description: 'FULL replacement markdown for PSEUDOCODE.md — only if a flow/algorithm changed.' },
      knowledge: { type: 'string', description: 'FULL replacement markdown for KNOWLEDGE.md — only if something was LEARNED (contract observed, gotcha hit).' },
      none: { type: 'boolean', description: 'true when no document needs updating this turn.' }
    }
  }
};

const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

const DOC_WRITER_PROMPT = ({ goal, filesTouched, stepDigest, known, current, files = [] }) =>
`You maintain a software project's canonical documentation after a change was executed. You are a precise technical writer, not a narrator.

STANDARDS — violations make the documentation worthless:
- Preserve each document's heading structure exactly; write under the existing headings.
- Update ONLY what this change affects; keep every other line verbatim.
- Present tense, declarative facts. Never narrate ("I added", "we then updated"), never chat voice, never address the reader.
- No filler ("This document describes…"), no restating the task, no summaries of your own edit.
- Concrete over general: real names, paths, commands, data shapes. Module map rows read: \`module — responsibility\`.
- KNOWLEDGE records only what was LEARNED: external contracts as observed, gotchas actually hit, consequences of decisions. It is not a change log.
- PSEUDOCODE holds compact indented outlines of flows that changed — the shape of the code, never real code.
- Keep each document under ~150 lines. An empty section is better than invented content.
- A document you cannot genuinely improve, you do not return. Nothing learned, nothing structural changed → none=true.

WHAT HAPPENED THIS TURN
GOAL: ${clip(goal, 300) || '(none stated)'}
FILES TOUCHED: ${filesTouched || '(none recorded)'}
STEP RESULTS:
${stepDigest || '(none)'}
${known ? '\n' + known : ''}

CHANGED FILE CONTENTS — document from THESE (real module names, real exports,
real data shapes), never from the step summaries alone:
${files.length ? files.map((f) => `### ${f.path}\n\`\`\`\n${clip(f.content, 5000)}\n\`\`\``).join('\n\n') : '(no file contents available — be correspondingly conservative)'}

CURRENT DOCUMENTS

### DESIGN.md
${clip(current.design, 8000) || '(missing)'}

### PSEUDOCODE.md
${clip(current.pseudocode, 8000) || '(missing)'}

### KNOWLEDGE.md
${clip(current.knowledge, 8000) || '(missing)'}

Call submit_docs now with full replacement markdown for ONLY the documents that need updating.`;

/** A returned doc must be plausible markdown, not a fragment or an apology. */
function validDoc(s) {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.startsWith('#') && t.includes('\n') && t.length >= 40 ? t + (t.endsWith('\n') ? '' : '\n') : null;
}

/**
 * Run the technical-writer pass.
 * @returns {Promise<{design?:string, pseudocode?:string, knowledge?:string}>}
 *   empty object on "nothing to update" AND on any failure — docs are never
 *   degraded by a bad model call.
 */
async function updateDocs({ connector, model, goal, stepResults = [], toolTrace = [], known = '', current = {}, files = [] }) {
  try {
    const touchedPaths = [...new Set(toolTrace
      .filter((t) => t.ok !== false && WRITING_TOOLS.includes(t.name))
      .map((t) => (t.args && t.args.path) || '').filter(Boolean))];
    const cmds = [...new Set(toolTrace
      .filter((t) => t.ok !== false && t.name === 'run_command')
      .map((t) => clip((t.args && t.args.command) || '', 80)).filter(Boolean))];
    const filesTouched = [touchedPaths.join(', '), cmds.length ? `commands: ${cmds.join(' · ')}` : '']
      .filter(Boolean).join(' — ');
    const stepDigest = stepResults
      .map((r) => `- [step ${r.step}] ${clip(r.task, 120)}: ${clip(r.conclusion, 300)}`).join('\n');

    const content = DOC_WRITER_PROMPT({ goal, filesTouched, stepDigest, known, current, files });
    const messages = [{ role: 'user', content }];
    let r;
    try {
      r = await connector.chat({ model, messages, tools: [SUBMIT_DOCS_TOOL], forceTool: true, maxTokens: 8000 });
    } catch {
      r = await connector.chat({ model, messages, tools: [SUBMIT_DOCS_TOOL], maxTokens: 8000 });
    }
    const call = (r.toolCalls || [])[0];
    const args = call && call.args && typeof call.args === 'object' ? call.args : {};
    if (args.none) return {};
    const out = {};
    for (const t of ['design', 'pseudocode', 'knowledge']) {
      const v = validDoc(args[t]);
      if (v) out[t] = v;
    }
    return out;
  } catch (e) {
    console.error('[doc-writer]', e && e.message);
    return {};
  }
}

module.exports = { updateDocs, SUBMIT_DOCS_TOOL, DOC_WRITER_PROMPT };
