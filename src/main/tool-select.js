'use strict';

// Tool selection — the fallback that fixes tool-schema bloat when no loaded skill
// declares a tool scope. MCP tool *schemas* are fixed overhead paid every turn
// (34 tools ≈ 17k tokens), regardless of relevance. This is the exact analog of
// skill selection: given the request and a cheap tool MENU (name + one-line
// description), pick only the tools this turn is likely to need and inject just
// those full schemas. `delegate`/`assign` are added separately and always kept.

const { extractJson } = require('./evaluator');

const SELECT_PROMPT = (menu, userText) =>
`You are a tool selector. Below is a menu of tools available to an assistant (name — what it does). Given the user's request, choose ONLY the tools that are plausibly needed to satisfy it THIS turn. Include a tool if there's a reasonable chance it's needed; exclude clearly irrelevant ones. Err slightly toward inclusion, but the goal is to cut a large catalog down to the relevant handful.

TOOLS:
${menu}

USER REQUEST:
${userText}

Return STRICT JSON and nothing else: {"tools":["exact-name", ...]}. Use exact names from the menu.`;

/**
 * @returns {Promise<{names:string[], error?:string}>}
 */
async function selectTools({ connector, model, tools, userText }) {
  const menu = tools
    .map((t) => `- ${t.name}: ${String(t.description || '').replace(/\s+/g, ' ').slice(0, 120)}`)
    .join('\n');
  const content = SELECT_PROMPT(menu, userText || '');
  // Generous budget: a thinking fast-model spends tokens reasoning before the JSON.
  const r = await connector.chat({ model, messages: [{ role: 'user', content }], maxTokens: 2500 });
  const msg = r.raw && r.raw.choices && r.raw.choices[0] ? r.raw.choices[0].message || {} : {};
  const raw = extractJson(r.text || '') || extractJson(msg.reasoning_content || msg.reasoning || '');
  if (!raw) return { names: [], error: 'tool selector returned no parseable JSON' };
  let parsed; try { parsed = JSON.parse(raw); } catch { return { names: [], error: 'tool selector JSON parse failed' }; }
  const want = new Set((parsed.tools || []).map((n) => String(n).toLowerCase()));
  const names = tools.filter((t) => want.has(String(t.name).toLowerCase())).map((t) => t.name);
  return { names };
}

module.exports = { selectTools, SELECT_PROMPT };
