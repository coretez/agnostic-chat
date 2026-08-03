'use strict';

// Meta-evaluator — a second LLM that critiques a turn's context-engineering.
//
// It is given a DIGEST of the turn (metrics + structure, never the raw bulk) and
// returns scored, actionable findings. Because the app is LLM-agnostic, the
// evaluator model can be a *different* model/provider than the chat that produced
// the turn (e.g. Claude grading a Kimi run).

const EVAL_PROMPT =
`You are a context-engineering evaluator for an LLM chat application. You are given a DIGEST of a single turn's internal pipeline — window occupancy by contributor, compaction events, tool-result sizes, sub-agent delegations and their token savings, a \`planning\` block describing the turn's skill/tool selection outcome, plus the user's request. You are NOT given the raw content (that is the point — judge the engineering, not the answer).

IMPORTANT: check \`planning\` FIRST. A failed planning call and a deliberate "nothing needed" decision produce the identical surface symptom (many tools offered, none called) — but they have completely different fixes. If \`planning.tools.fellBackToFullCatalog\` is true or \`planning.skills.error\` is set, that means the app's selection mechanism ran and failed THIS turn — do not recommend building selection/retrieval/caps as if none existed; instead flag it as a reliability failure of the existing mechanism (category "tools" or "context", target "app", pointing at the failure itself).

Critique how efficiently this turn used the model's context window and tools, and propose concrete improvements. Look especially for:
- a planning failure (see above) being misdiagnosed as missing infrastructure;
- large tool results dumped into the MAIN thread that should have been delegated to a sub-agent (isolation) instead;
- many tools offered but few used, when planning did NOT fail (genuine selection waste, not a failure);
- compaction firing too early or too late relative to occupancy;
- sub-agent tasks that look under-specified;
- prompt/skill bloat inflating the fixed overhead, when planning did NOT fail.

Classify each finding's target:
- "usage": something the operator driving the chat should do differently;
- "strategy": a tuning change to the context policy (ratios, thresholds);
- "app": a capability the product should build/fix.

Return STRICT JSON and nothing else:
{"assessment":"one-line overall read","findings":[{"category":"context|delegation|tools|compaction|prompt","severity":"high|med|low","observation":"specific, tied to the numbers in the digest","suggestion":"one concrete action","target":"usage|strategy|app"}]}
At most 6 findings, most important first. If the turn was already efficient, say so with few or zero findings.

Output ONLY the JSON object — no markdown fences, no reasoning, no text before or after it.`;

// Pull the first balanced {...} JSON object out of a model reply (models often
// wrap JSON in prose or fences despite instructions).
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/**
 * @param {object} o
 * @param {object} o.connector provider connector ({chat})
 * @param {string} o.model     evaluator model id
 * @param {object} o.digest    compact turn digest (from the renderer)
 * @returns {Promise<{assessment, findings}|{error}>}
 */
async function runEvaluator({ connector, model, digest }) {
  const content = EVAL_PROMPT + '\n\nDIGEST:\n' + JSON.stringify(digest, null, 2);
  // Thinking models (kimi-k2.x, etc.) burn the budget on reasoning before emitting
  // JSON, and often return the answer in a separate `reasoning_content` field with
  // `content` empty. Give a large ceiling and look in both places.
  const r = await connector.chat({ model, messages: [{ role: 'user', content }], maxTokens: 8000 });
  const msg = r.raw && r.raw.choices && r.raw.choices[0] ? r.raw.choices[0].message || {} : {};
  const finish = r.raw && r.raw.choices && r.raw.choices[0] ? r.raw.choices[0].finish_reason : undefined;
  const text = r.text || '';
  const reasoning = msg.reasoning_content || msg.reasoning || '';
  console.error('[evaluator]', model, 'finish=', finish, 'contentLen=', text.length, 'reasoningLen=', reasoning.length);

  // Prefer JSON from content; fall back to the reasoning field.
  const raw = extractJson(text) || extractJson(reasoning);
  if (!raw) {
    const dump = (text || reasoning || '').slice(0, 800);
    console.error('[evaluator] no parseable JSON from', model, '— dump:', JSON.stringify(dump.slice(0, 400)));
    let hint;
    if (finish === 'length') hint = 'reply was cut off at the token limit before valid JSON (thinking model used the budget on reasoning — raise the limit or use a non-thinking evaluator)';
    else if (!text.trim() && !reasoning.trim()) hint = 'model returned an empty reply (its token budget may have been consumed by hidden reasoning) — try a non-thinking model as the evaluator';
    else hint = 'model replied but not as JSON — try a non-thinking model as the evaluator';
    return { error: hint, raw: dump, findings: [] };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    console.error('[evaluator] JSON parse failed from', model, '— raw:', JSON.stringify(raw.slice(0, 400)));
    return { error: 'JSON parse failed (possibly truncated)', raw: raw.slice(0, 800), findings: [] };
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings.slice(0, 6) : [];
  return { assessment: parsed.assessment || '', findings };
}

module.exports = { runEvaluator, extractJson, EVAL_PROMPT };
