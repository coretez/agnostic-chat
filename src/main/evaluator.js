'use strict';

// Meta-evaluator — a second LLM that critiques a turn's context-engineering.
//
// It is given a DIGEST of the turn (metrics + structure, never the raw bulk) and
// returns scored, actionable findings. Because the app is LLM-agnostic, the
// evaluator model can be a *different* model/provider than the chat that produced
// the turn (e.g. Claude grading a Kimi run).

const EVAL_PROMPT =
`You are a context-engineering evaluator for an LLM chat application that uses a PLAN-AND-EXECUTE turn architecture. Each turn runs: Pass 1 selects which skills to load and which tools to expose (\`planning\` block); Pass 2 derives an ordered step plan FROM the loaded skill's instructions, with per-step declared outputs ("produces"), delegation flags, and a merge contract (\`execution.plan\`); steps then execute against a shared variable store (working memory of discovered ids/paths that later steps reuse); stuck steps auto-re-plan (≤3) before escalating to the user; a final synthesis combines step results per the plan's merge instruction. Trivial requests skip Pass 2 (\`execution.mode\` = "flat-loop").

You are given a DIGEST of one turn — window occupancy by contributor, compaction events, tool-result sizes, delegations, the \`planning\` block (Pass 1), the \`execution\` block (Pass 2 + the run), plus the user's request. You are NOT given the raw content (that is the point — judge the engineering, not the answer).

Check in this order:
1. \`execution.turnComplete\` — if false, the turn is STILL RUNNING: tool/utilization counts are so-far, not final. Do not report "N tools offered, 0 used" as waste on an in-flight turn; confine findings to fixed overhead (occupancy, skill/tool token cost), and say the read is partial.
2. \`planning\` (Pass 1) — a failed selection call and a deliberate "nothing needed" decision look identical from outside (many tools offered, none called) but have different fixes. If \`planning.tools.fellBackToFullCatalog\` or \`planning.skills.error\` is set, the selection mechanism ran and FAILED this turn — flag the reliability failure (target "app"); do not recommend building selection as if none existed.
3. \`execution\` (Pass 2) — judge the PLAN, not just the context:
   - mode "flat-loop" on a request that plainly implies a multi-step procedure (investigate/report/audit) = a planning-quality failure (category "planning") — the gate judged it simple, or derivation failed/timed out.
   - a plan whose steps do NOT reflect the loaded skill's own workflow (steps generic, no "produces", no step saving/recording the deliverable a skill prescribes) = weak derivation (category "planning").
   - \`plan.varsCaptured\` = 0 across a completed multi-step run = the working-memory capture failed or steps didn't declare produces (category "variables").
   - replans near 3 or \`escalatedToUser\` = the plan or a step is fighting reality — look at which step stuck.
   - completed=false = the turn ended on a declined escalation; findings should focus on the blocking step.
4. Efficiency, only after the above: oversized tool results that belonged in a delegated step; genuinely unused tools when planning did NOT fail AND the turn is complete; skill/prompt bloat in fixed overhead; compaction timing vs occupancy.

Classify each finding's target:
- "usage": something the operator driving the chat should do differently;
- "strategy": a tuning change to the context policy (ratios, thresholds, budgets);
- "app": a capability the product should build/fix.

Return STRICT JSON and nothing else:
{"assessment":"one-line overall read","findings":[{"category":"planning|variables|context|delegation|tools|compaction|prompt","severity":"high|med|low","observation":"specific, tied to the numbers in the digest","suggestion":"one concrete action","target":"usage|strategy|app"}]}
At most 6 findings, most important first. If the turn was already efficient and the plan followed the skill, say so with few or zero findings.

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
