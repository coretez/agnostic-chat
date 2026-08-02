'use strict';

// Skill selection — a pipeline ACTION that decides which skills' full instructions
// to load for a given prompt, instead of dumping every enabled skill into context.
//
// Enabled skills are only *candidates*. The model is always shown a cheap MENU
// (name + one-line "when to use"); the expensive full definitions are loaded only
// for the skills this selector picks. This is how a 231k skill dump becomes ~10k.

const { extractJson } = require('./evaluator');

function buildMenu(skills) {
  return skills
    .map((s) => `- ${s.name}: ${String(s.description || '').replace(/\s+/g, ' ').slice(0, 180)}`)
    .join('\n');
}

const SELECT_PROMPT = (menu, userText) =>
`You are a skill selector. Below is a menu of skills available for this project (name — when to use). Given the user's request, choose ONLY the skills whose full instructions should be loaded into context for THIS turn. Be frugal: pick a skill only if it is clearly relevant; pick none if none apply.

SKILLS:
${menu}

USER REQUEST:
${userText}

Return STRICT JSON and nothing else: {"skills":["exact-name", ...]}. Use the exact names from the menu. Empty array if none apply.`;

/**
 * @returns {Promise<{selected:Array, names:string[], error?:string}>}
 */
async function selectSkills({ connector, model, skills, userText }) {
  const menu = buildMenu(skills);
  const content = SELECT_PROMPT(menu, userText || '');
  const r = await connector.chat({ model, messages: [{ role: 'user', content }], maxTokens: 600 });
  const msg = r.raw && r.raw.choices && r.raw.choices[0] ? r.raw.choices[0].message || {} : {};
  const reasoning = msg.reasoning_content || msg.reasoning || '';
  const raw = extractJson(r.text || '') || extractJson(reasoning);
  if (!raw) return { selected: [], names: [], error: 'selector returned no parseable JSON' };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { selected: [], names: [], error: 'selector JSON parse failed' }; }
  const want = new Set((parsed.skills || []).map((n) => String(n).toLowerCase()));
  const selected = skills.filter((s) => want.has(String(s.name).toLowerCase()));
  return { selected, names: selected.map((s) => s.name) };
}

module.exports = { selectSkills, buildMenu, SELECT_PROMPT };
