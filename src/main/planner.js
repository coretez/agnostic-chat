'use strict';

// Planning mode — a system-driven orchestrator.
//
// makePlan() strategizes a request into a structured, decomposable plan (goal +
// steps + how to merge). The user approves it, then runPlan() executes it
// deterministically: fan out steps to isolated sub-agents (parallel where the
// plan says so), then AI-MERGE their results via mergeResults(). This makes
// decompose-and-merge deliberate instead of leaving it to the model's whim.

const { extractJson } = require('./evaluator');
const { runSubagent, mergeResults } = require('./subagent');

const PLAN_PROMPT = (ctx, request) =>
`You are a planner for an LLM assistant. Turn the user's request into a concise execution plan that decomposes it into steps which can each run as an ISOLATED sub-agent task, then be merged into one answer.

${ctx}

USER REQUEST:
${request}

Return STRICT JSON and nothing else:
{"goal":"one-line goal","steps":[{"task":"complete, self-contained instruction for a sub-agent","agent":"an available agent name or \\"auto\\"","parallel":true}],"merge":"how to combine the step results into the final answer"}

Rules: prefer 2–5 steps; set "parallel":true for steps that don't depend on each other; use a named agent when one clearly fits, else "auto"; if the request is simple and needs no decomposition, return a single step with an empty "merge".`;

/**
 * @returns {Promise<{goal, steps:Array, merge:string}|{error}>}
 */
async function makePlan({ connector, model, request, cheatSheet, skillsMenu, agents }) {
  const parts = [];
  if (cheatSheet) parts.push('PROJECT BRIEF:\n' + cheatSheet);
  if (agents && agents.length) parts.push('AVAILABLE AGENTS:\n' + agents.map((a) => `- ${a.name}: ${a.description || ''}`).join('\n'));
  if (skillsMenu) parts.push('AVAILABLE SKILLS:\n' + skillsMenu);
  const ctx = parts.join('\n\n') || '(no additional project context)';
  const r = await connector.chat({ model, messages: [{ role: 'user', content: PLAN_PROMPT(ctx, request || '') }], maxTokens: 1500 });
  const raw = extractJson(r.text || '') || extractJson((r.raw && r.raw.choices && r.raw.choices[0] && (r.raw.choices[0].message.reasoning_content || '')) || '');
  if (!raw) return { error: 'planner returned no parseable JSON', findings: [] };
  let p; try { p = JSON.parse(raw); } catch { return { error: 'planner JSON parse failed' }; }
  const steps = Array.isArray(p.steps) ? p.steps.filter((s) => s && s.task).map((s, i) => ({ id: i + 1, task: s.task, agent: s.agent || 'auto', parallel: !!s.parallel })) : [];
  return { goal: p.goal || '', steps, merge: typeof p.merge === 'string' ? p.merge : '' };
}

/**
 * Execute an APPROVED plan: run steps (parallel batches), then AI-merge.
 * @param {object} o
 * @param {object} o.plan            {goal, steps, merge}
 * @param {object} o.connector
 * @param {string} o.model
 * @param {string} o.fastModel
 * @param {function} o.resolveAgent  (name) => {agent, model, tools}
 * @param {function} o.callTool      MCP tool router (no delegate)
 * @param {function} [o.onEvent]
 * @returns {Promise<{answer, results:Array}>}
 */
async function runPlan({ plan, connector, model, fastModel, resolveAgent, callTool, onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const steps = (plan && plan.steps) || [];
  emit({ type: 'process', kind: 'plan-start', goal: plan.goal, steps: steps.length });

  const runStep = async (s) => {
    const { agent, model: m, tools: st } = resolveAgent(s.agent);
    const r = await runSubagent({ connector, model: m, fastModel, agent, task: s.task, tools: st, callTool, onEvent: emit });
    return { agent: agent.name, task: s.task, conclusion: r.conclusion, inputTokens: r.inputTokens, durationMs: r.durationMs };
  };

  // Run consecutive parallel steps together; sequential steps one at a time.
  const results = [];
  let i = 0;
  while (i < steps.length) {
    if (steps[i].parallel) {
      const batch = [];
      while (i < steps.length && steps[i].parallel) { batch.push(steps[i]); i++; }
      results.push(...await Promise.all(batch.map(runStep)));
    } else {
      results.push(await runStep(steps[i])); i++;
    }
  }

  let answer;
  if (results.length === 0) answer = '(plan had no runnable steps)';
  else if (results.length === 1 && !plan.merge) answer = results[0].conclusion;
  else answer = await mergeResults({ connector, model, instruction: plan.merge || 'Combine the step results into one coherent, complete answer.', results, onEvent: emit });

  emit({ type: 'process', kind: 'plan-done', steps: results.length });
  return { answer, results };
}

module.exports = { makePlan, runPlan, PLAN_PROMPT };
