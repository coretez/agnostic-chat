'use strict';

// O11 (v1) — the verify stage beyond "it works". After a coding turn's
// execution, two critic lenses review the ACTUAL changed files in parallel:
//
//   quality   was it written correctly — DRY, modular, no brute force
//   security  is it safe — injection, secrets, unsafe exec, traversal
//
// Deterministic trigger (ipc.js), like step-commits and the doc-writer.
// Confirmed findings (high/med only) get ONE bounded fix step; the loop does
// not spiral — remaining concerns surface honestly in the reply. Critics are
// told an empty list is a good outcome, and their findings are validated
// here: unknown files, junk severities, and padding are dropped.

const SUBMIT_REVIEW_TOOL = {
  name: 'submit_review',
  description: 'Report the review findings for the changed files. An empty findings list means the code passes this lens — that is a good outcome, never pad.',
  inputSchema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        description: 'Real problems only, at most 4. No style nits, no speculation about code you cannot see.',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', description: 'high | med — low-severity nits are not worth a fix cycle; omit them.' },
            file: { type: 'string', description: 'The changed file the finding is in (exactly as listed).' },
            issue: { type: 'string', description: 'The problem, concretely, in one sentence.' },
            fix: { type: 'string', description: 'The specific change that resolves it, in one sentence.' }
          },
          required: ['file', 'issue']
        }
      },
      clean: { type: 'boolean', description: 'true when this lens found nothing worth fixing.' }
    }
  }
};

const LENSES = {
  quality:
    'You are a code-quality reviewer. Find REAL construction problems in the changed files: '
    + 'duplication that should be extracted (DRY), brute-force implementations where a simpler '
    + 'idiom exists, functions doing several unrelated jobs, module boundaries violated, '
    + 'copy-paste drift, dead code. Correct-but-crude counts: if it works by force where design '
    + 'was available, report it.',
  security:
    'You are a security reviewer. Find REAL vulnerabilities in the changed files: command/SQL/path '
    + 'injection, secrets or credentials embedded in code, unsafe eval/exec, path traversal, '
    + 'unvalidated external input reaching dangerous sinks, insecure defaults. high = exploitable, '
    + 'med = a genuine weakness.'
};

const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; };

const REVIEW_PROMPT = (lens, goal, files) =>
`${LENSES[lens]}

Judge ONLY what is in these files — do not invent context or speculate about code you cannot see. Report at most 4 findings; an empty list is a good outcome, never pad.

GOAL OF THE CHANGE: ${clip(goal, 240) || '(not stated)'}

CHANGED FILES:
${files.map((f) => `### ${f.path}\n\`\`\`\n${clip(f.content, 6000)}\n\`\`\``).join('\n\n')}

Call submit_review now.`;

async function runLens({ connector, model, lens, goal, files }) {
  const messages = [{ role: 'user', content: REVIEW_PROMPT(lens, goal, files) }];
  let r;
  try {
    r = await connector.chat({ model, messages, tools: [SUBMIT_REVIEW_TOOL], forceTool: true, maxTokens: 3000 });
  } catch {
    r = await connector.chat({ model, messages, tools: [SUBMIT_REVIEW_TOOL], maxTokens: 3000 });
  }
  const call = (r.toolCalls || [])[0];
  const args = call && call.args && typeof call.args === 'object' ? call.args : {};
  if (args.clean) return [];
  return (Array.isArray(args.findings) ? args.findings : []).map((f) => ({ ...f, lens }));
}

/**
 * Review the changed files through both lenses, in parallel.
 * @returns {Promise<{findings:Array<{lens,severity,file,issue,fix}>}>}
 *   validated (known files, high/med only), deduped, capped at 6.
 *   Any failure returns {findings: []} — review can never break a turn.
 */
async function reviewChanges({ connector, model, files = [], goal = '' }) {
  try {
    if (!files.length) return { findings: [] };
    const known = new Set(files.map((f) => f.path));
    const results = await Promise.all(
      Object.keys(LENSES).map((lens) =>
        runLens({ connector, model, lens, goal, files }).catch(() => []))
    );
    const seen = new Set();
    const findings = [];
    for (const f of results.flat()) {
      if (!f || typeof f.issue !== 'string' || !f.issue.trim()) continue;
      if (!known.has(f.file)) continue;                       // no speculation about unseen files
      const sev = String(f.severity || 'med').toLowerCase();
      if (sev !== 'high' && sev !== 'med') continue;          // nits don't earn a fix cycle
      const key = f.file + '|' + f.issue.trim().slice(0, 40).toLowerCase();
      if (seen.has(key)) continue;                             // both lenses may spot the same thing
      seen.add(key);
      findings.push({ lens: f.lens, severity: sev, file: f.file, issue: f.issue.trim(), fix: clip(String(f.fix || '').trim(), 300) });
      if (findings.length >= 6) break;
    }
    // high before med — if the fix step runs out of budget, it fixes the worst first.
    findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
    return { findings };
  } catch (e) {
    console.error('[review]', e && e.message);
    return { findings: [] };
  }
}

module.exports = { reviewChanges, SUBMIT_REVIEW_TOOL, REVIEW_PROMPT, LENSES };
