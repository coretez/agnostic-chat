'use strict';

// Unified turn-context planner — one LLM call that decides BOTH which project
// skills to load in full and which MCP tools to expose, replacing what used
// to be two separately-gated calls (skill-select.js + tool-select.js). Always
// runs when there's anything to plan; the break-even for one more fast-model
// call against a cheap name+description menu is low, and gating on size
// thresholds was exactly what let a turn's fixed overhead (skills + tool
// schemas) balloon past what a request actually needed.

const { extractJson } = require('./evaluator');

// A hard character cut can slice off the exact trigger clause a description
// was written around (verified in production: a 160-char cap chopped a
// skill's "when to use" sentence off one word before its match keyword,
// silently making the skill unselectable for the requests it names). Cut at
// the nearest sentence boundary within a grace window instead of mid-clause;
// only hard-truncate as a last resort for a genuinely huge run-on description.
function truncateForMenu(text, cap, grace) {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= cap) return collapsed;
  const window = collapsed.slice(0, cap + grace);
  const cut = window.lastIndexOf('. ');
  if (cut > cap * 0.5) return window.slice(0, cut + 1);
  return collapsed.slice(0, cap) + '…';
}
function skillLine(s) {
  // No normal-case truncation here. The skill editor's own contract for this
  // field is "one line — when to use it" — it's authored specifically to be
  // the exact trigger signal this call decides on, and there are typically a
  // few dozen of these, not hundreds. Cutting it defeats its purpose (proven
  // in production). The generous ceiling below is a pathological-input guard
  // (someone pastes paragraphs into a one-line field), not a routine cap.
  const desc = truncateForMenu(s.description, 4000, 200);
  const scope = Array.isArray(s.tools) && s.tools.length ? ` (tools: ${s.tools.join(', ')})` : '';
  return `- ${s.name}: ${desc}${scope}`;
}
function toolLine(t) {
  return `- ${t.name}: ${truncateForMenu(t.description, 160, 40)}`;
}

const SELECT_PROMPT = (skillMenu, toolMenu, userText) =>
`You are a context planner for an LLM assistant. Given the user's request, decide which of the following SKILLS should have their full instructions loaded for this turn, and which TOOLS should be made available.

For BOTH, err toward inclusion when there's a reasonable chance it's needed — judge the underlying intent, not literal wording overlap with a skill's description. A request to investigate a specific person, account, or email address is the same kind of task as a skill described as "investigate a case" or "triage an incident", even though it doesn't say "case id" — don't require an exact phrase match. The goal is real narrowing versus dumping everything, not a rubric that only fires on an exact keyword hit. A skill's instructions are cheap to include; missing the one relevant skill (leaving the model with no domain guidance at all) is a worse failure than including one that turns out unused.

SKILLS (name — when to use):
${skillMenu || '(none available)'}

TOOLS (name — what it does):
${toolMenu || '(none available)'}

USER REQUEST:
${userText}

Call select_context with your decision. Use exact names from the menus above, copied exactly as written (same spelling, punctuation, case) — do not paraphrase, retitle, or reformat them. Empty arrays are fine if nothing applies.`;

// Synthetic tool used purely as a structured-output contract — forcing this
// call instead of prompting for freeform JSON means the provider's own
// function-calling layer guarantees syntactically valid arguments once
// generation starts. Prompted JSON repeatedly failed in production ("context
// selector JSON parse failed") when a thinking model's prose ran out of
// budget before closing its JSON cleanly; a forced tool call doesn't have
// that failure mode in the same way.
const SELECT_CONTEXT_TOOL = {
  name: 'select_context',
  description: "Report which skills and tools are relevant to the user's request for this turn.",
  inputSchema: {
    type: 'object',
    properties: {
      skills: { type: 'array', items: { type: 'string' }, description: 'Exact skill names to load in full. Empty array if none apply.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Exact tool names to expose. Empty array if none apply.' }
    },
    required: ['skills', 'tools']
  }
};

/**
 * One call that plans both halves of a turn's context: which skills to load
 * in full, which tools to expose. Skips the call entirely if there is
 * nothing to plan (no skills, no tools) — not a size-based bypass, a
 * degenerate no-op.
 * @returns {Promise<{skillNames:string[], toolNames:string[], error?:string}>}
 */
async function selectContext({ connector, model, skills = [], tools = [], userText }) {
  if (!skills.length && !tools.length) return { skillNames: [], toolNames: [] };
  const skillMenu = skills.map(skillLine).join('\n');
  const toolMenu = tools.map(toolLine).join('\n');
  const content = SELECT_PROMPT(skillMenu, toolMenu, userText || '');
  // Generous budget: this one call now reasons over BOTH menus at once (could
  // be 200+ tools plus dozens of skills — a much bigger combined space than
  // either of the two calls this replaced), and a thinking fast-model burns
  // tokens reasoning before it ever emits its answer.
  const messages = [{ role: 'user', content }];
  let r;
  try {
    r = await connector.chat({ model, messages, tools: [SELECT_CONTEXT_TOOL], forceTool: true, maxTokens: 8000 });
  } catch (e) {
    // Some thinking/reasoning models reject a FORCED tool choice outright
    // (seen in production: HTTP 400 "tool_choice 'specified' is incompatible
    // with thinking enabled") — forcing requires disabling their own
    // reasoning step, which some providers simply won't do. Retry once with
    // the tool merely OFFERED (tool_choice left to the model) instead of
    // forced — thinking-compatible, and the model still has every reason to
    // call the one tool it's given plus the prompt's explicit instruction to.
    try {
      r = await connector.chat({ model, messages, tools: [SELECT_CONTEXT_TOOL], maxTokens: 8000 });
    } catch (e2) {
      return { skillNames: [], toolNames: [], error: `context selector failed: ${e2.message}` };
    }
  }
  const call = (r.toolCalls || [])[0];
  let parsed = (call && call.args && typeof call.args === 'object') ? call.args : null;
  if (!parsed) {
    // Fallback for a connector/provider that didn't honor forced tool-calling
    // and answered in prose anyway.
    const msg = r.raw && r.raw.choices && r.raw.choices[0] ? r.raw.choices[0].message || {} : {};
    const raw = extractJson(r.text || '') || extractJson(msg.reasoning_content || msg.reasoning || '');
    if (!raw) return { skillNames: [], toolNames: [], error: 'context selector returned no tool call and no parseable JSON' };
    try { parsed = JSON.parse(raw); } catch { return { skillNames: [], toolNames: [], error: 'context selector JSON parse failed' }; }
  }
  const wantSkills = new Set((parsed.skills || []).map((n) => String(n).toLowerCase()));
  const wantTools = new Set((parsed.tools || []).map((n) => String(n).toLowerCase()));
  const skillNames = skills.filter((s) => wantSkills.has(s.name.toLowerCase())).map((s) => s.name);
  const toolNames = tools.filter((t) => wantTools.has(t.name.toLowerCase())).map((t) => t.name);

  // A successful call that named something matching NOTHING we know (typo'd,
  // paraphrased, wrong id) looks identical from the outside to "the model
  // deliberately picked none" — both end up 0 loaded — but they have very
  // different causes. Tracked independently (not one shared field) so a
  // skill-side mismatch surfaces even when the tool side worked fine, and
  // vice versa.
  const rawSkillNames = (parsed.skills || []).map(String);
  const rawToolNames = (parsed.tools || []).map(String);
  const skillMismatch = (rawSkillNames.length && !skillNames.length)
    ? `named skills ${JSON.stringify(rawSkillNames)} but none matched a known skill name` : undefined;
  const toolMismatch = (rawToolNames.length && !toolNames.length)
    ? `named tools ${JSON.stringify(rawToolNames)} but none matched a known tool name` : undefined;

  return { skillNames, toolNames, skillMismatch, toolMismatch };
}

/**
 * Deterministic (no LLM) enforcement of a skill's declared tool scope — the
 * skill editor documents an explicit tools list as a restriction ("blank =
 * no restriction"), i.e. a ceiling the operator authored on purpose, not
 * just a relevance hint the planner can override.
 * @param {object} o
 * @param {Array}  o.loadedSkills the skills selected for this turn (full rows, with `.tools`)
 * @param {string[]} o.toolNames  the planner's chosen tool names
 * @param {Array}  o.allTools    the full connected tool catalog
 * @param {number} [o.fallbackCap=Infinity] optional cap on the last-resort
 *   fallback when there's no ceiling and the planner's picks are empty (call
 *   failed / hallucinated names). Defaults to no cap: an arbitrary slice of
 *   an unordered catalog has no basis for excluding exactly the tools this
 *   turn needed — seen in production (a 32-tool slice of a 205-tool catalog
 *   omitted every case-investigation tool). manager.js's MAX_TOOLS already
 *   bounds the pathological catalog-size case; this only governs the rare
 *   total-planning-failure path, where correctness should win over economy.
 * @returns {{tools:Array, bySkills:string[]|null, fellBack:boolean}}
 */
function applyToolCeiling({ loadedSkills = [], toolNames = [], allTools = [], fallbackCap = Infinity }) {
  const wantTools = new Set(toolNames.map((n) => String(n).toLowerCase()));
  let picked = allTools.filter((t) => wantTools.has(t.name.toLowerCase()));

  const scopedSkills = loadedSkills.filter((s) => Array.isArray(s.tools) && s.tools.length);
  const hasUnscopedLoaded = loadedSkills.some((s) => !Array.isArray(s.tools) || !s.tools.length);
  let bySkills = null;
  if (scopedSkills.length && !hasUnscopedLoaded) {
    const allowed = new Set(scopedSkills.flatMap((s) => s.tools));
    const ceiling = allTools.filter((t) => allowed.has(t.name));
    // A skill's declared tool names are free text (typo, stale rename, wrong
    // server prefix) — if NONE of them match anything actually connected,
    // treat it as misconfiguration, not a real ceiling (same safe-default as
    // the flow this replaces): ignore it rather than leaving zero tools.
    if (ceiling.length) {
      const ceilingNames = new Set(ceiling.map((t) => t.name));
      const intersected = picked.filter((t) => ceilingNames.has(t.name));
      // The planner picked nothing inside the declared scope (or failed
      // entirely) — trust the operator's authored ceiling over an empty result.
      picked = intersected.length ? intersected : ceiling;
      bySkills = scopedSkills.map((s) => s.name);
    }
  }

  let fellBack = false;
  if (!picked.length && !bySkills) {
    // No ceiling to fall back on and nothing picked (call failed / returned
    // nothing parseable / hallucinated names) — no signal to narrow on at all.
    picked = allTools.slice(0, fallbackCap);
    fellBack = true;
  }

  return { tools: picked, bySkills, fellBack };
}

module.exports = { selectContext, applyToolCeiling, SELECT_PROMPT, SELECT_CONTEXT_TOOL, truncateForMenu };
