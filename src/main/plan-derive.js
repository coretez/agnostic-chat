'use strict';

// Plan Pass 2 — step derivation ("skill iteration") for the plan-and-execute
// turn model. Pass 1 (context-select.js) picks which skills/tools are in play;
// this pass reads the LOADED skill instructions and derives the ordered steps
// that will actually be executed. refinePlan() is the REACTIVE half: when a
// step gets stuck, it re-derives the remaining tail from results-so-far
// (decisions #1/#2 in docs/PLANNING_ARCHITECTURE.md §9 — no proactive
// needsMore loop; re-planning happens on demand, bounded by the caller).
//
// Uses the same forced-tool structured-output pattern as selectContext, with
// the same offered-tool retry for thinking models that reject a forced
// tool_choice.

const { truncateForMenu } = require('./context-select');

// Synthetic tool as a structured-output contract (see context-select.js for
// why forced tool-calling beats prompted JSON here).
const SUBMIT_PLAN_TOOL = {
  name: 'submit_plan',
  description: "Report the execution plan for the user's request.",
  inputSchema: {
    type: 'object',
    properties: {
      simple: { type: 'boolean', description: 'true if the request needs no multi-step plan (answer directly / a single tool call at most).' },
      goal: { type: 'string', description: 'One-line statement of what done looks like.' },
      steps: {
        type: 'array',
        description: 'Ordered steps. Each is a complete, self-contained instruction. Omit or leave empty when simple=true.',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Complete instruction for this step.' },
            parallel: { type: 'boolean', description: 'true only if this step is independent of its neighbors and can run as an isolated sub-agent.' },
            agent: { type: 'string', description: 'Named agent to delegate a parallel step to, or "auto".' }
          },
          required: ['task']
        }
      }
    },
    required: ['simple', 'goal']
  }
};

const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

function planContext({ cheatSheet, loadedSkills = [], tools = [], store, agents = [] }) {
  const parts = [];
  if (cheatSheet) parts.push('PROJECT BRIEF:\n' + clip(cheatSheet, 4000));
  if (loadedSkills.length) {
    // The whole point of Pass 2: the SKILL'S OWN INSTRUCTIONS shape the steps.
    // Generous clip: a real SKILL.md procedure runs ~20k chars (~5k tok) and
    // cutting mid-procedure yields plans that stop where the clip did; the
    // planning call is a one-off fast-model call, so completeness wins here.
    parts.push('SKILL INSTRUCTIONS IN PLAY (derive your steps from these):\n\n'
      + loadedSkills.map((s) => `## ${s.name}\n${clip(s.definition || s.description || '', 24000)}`).join('\n\n'));
  }
  if (tools.length) {
    // Name + a one-line description (same sentence-boundary clip the selection
    // menu uses): the planner can only sequence steps sensibly if it knows what
    // each tool DOES, not just what it is called. Bare names produced plans
    // that guessed at tool behavior. Descriptions here are already scoped —
    // this list is the post-ceiling toolset, not the full catalog.
    parts.push('AVAILABLE TOOLS (name — what it does):\n'
      + tools.map((t) => `- ${t.name}: ${truncateForMenu(t.description, 200, 60)}`).join('\n'));
  }
  if (agents.length) parts.push('NAMED AGENTS (for parallel steps):\n' + agents.map((a) => `- ${a.name}: ${clip(a.description, 160)}`).join('\n'));
  const known = store && typeof store.render === 'function' ? store.render() : '';
  if (known) parts.push(known);
  return parts.join('\n\n') || '(no additional context)';
}

const DERIVE_PROMPT = (ctx, request) =>
`You are the planning stage of an LLM assistant. Decide whether the user's request needs a multi-step plan, and if so derive the steps — informed by the skill instructions in play (they often prescribe a procedure: follow it).

${ctx}

USER REQUEST:
${request}

Guidance:
- If the request is conversational or trivially answerable, call submit_plan with simple=true and no steps.
- Otherwise prefer 2–6 concrete, ordered steps. Each step must be a complete instruction that could be executed on its own with the values known so far.
- Mark a step "parallel" ONLY if it does not depend on values discovered by other steps.
- Steps that discover identifiers (ids, paths, names) should come before steps that use them.

Call submit_plan now.`;

const REFINE_PROMPT = (ctx, goal, doneDigest, stuck, reason, request) =>
`You are re-planning mid-execution. The goal below is partially complete, but the current step is stuck — revise the REMAINING steps using everything learned so far. Do not repeat completed work.

${ctx}

GOAL: ${goal}

COMPLETED SO FAR:
${doneDigest || '(nothing completed yet)'}

STUCK STEP: ${stuck.task}
WHY IT STUCK: ${reason} — its partial result: ${clip(stuck.partial, 1200) || '(none)'}

ORIGINAL REQUEST:
${request}

Call submit_plan with the revised REMAINING steps only (a different approach to the stuck work, or a way around it). If everything needed is already gathered and no further steps are required, return simple=true with no steps.`;

async function callForPlan(connector, model, content) {
  const messages = [{ role: 'user', content }];
  let r;
  try {
    r = await connector.chat({ model, messages, tools: [SUBMIT_PLAN_TOOL], forceTool: true, maxTokens: 8000 });
  } catch (e) {
    // Thinking models can reject forced tool_choice — retry with it offered.
    r = await connector.chat({ model, messages, tools: [SUBMIT_PLAN_TOOL], maxTokens: 8000 });
  }
  const call = (r.toolCalls || [])[0];
  return (call && call.args && typeof call.args === 'object') ? call.args : null;
}

function normalizeSteps(steps, startId = 1) {
  return (Array.isArray(steps) ? steps : [])
    .filter((s) => s && typeof s.task === 'string' && s.task.trim())
    .map((s, i) => ({ id: startId + i, task: s.task.trim(), parallel: !!s.parallel, agent: s.agent || 'auto' }));
}

/**
 * Derive the turn's plan from the loaded skills + tools + known values.
 * @returns {Promise<{simple:boolean, goal:string, steps:Array, error?:string}>}
 *   On any failure returns {simple:true} — the caller falls back to the flat
 *   loop, so planning can never make a turn WORSE than today's behavior.
 */
async function derivePlan({ connector, model, userText, cheatSheet, loadedSkills, tools, store, agents }) {
  try {
    const ctx = planContext({ cheatSheet, loadedSkills, tools, store, agents });
    const parsed = await callForPlan(connector, model, DERIVE_PROMPT(ctx, userText || ''));
    if (!parsed) return { simple: true, goal: '', steps: [], error: 'planner returned no tool call' };
    const steps = normalizeSteps(parsed.steps);
    // A 0/1-step plan is the trivial-turn gate: nothing to orchestrate.
    if (parsed.simple || steps.length <= 1) return { simple: true, goal: parsed.goal || '', steps };
    return { simple: false, goal: parsed.goal || '', steps };
  } catch (e) {
    return { simple: true, goal: '', steps: [], error: `derivePlan failed: ${e.message}` };
  }
}

/**
 * Reactive re-plan of the remaining tail after a stuck step (decision #1).
 * Matches the `refinePlan` signature executePlan expects.
 * @returns {Promise<{steps:Array}>} empty steps = "nothing more needed".
 */
async function refinePlan({ connector, model, userText, cheatSheet, loadedSkills, tools, agents, plan, done = [], stuckStep, reason, partial, store }) {
  try {
    const ctx = planContext({ cheatSheet, loadedSkills, tools, store, agents });
    const doneDigest = done.map((d) => `- [step ${d.step}] ${clip(d.task, 160)}: ${clip(d.conclusion, 400)}`).join('\n');
    const stuck = { task: stuckStep ? stuckStep.task : '', partial: partial || '' };
    const parsed = await callForPlan(connector, model, REFINE_PROMPT(ctx, (plan && plan.goal) || '', doneDigest, stuck, reason || 'stuck', userText || ''));
    if (!parsed) return { steps: [] };
    if (parsed.simple) return { steps: [] };
    const startId = stuckStep && stuckStep.id ? stuckStep.id : 1;
    return { steps: normalizeSteps(parsed.steps, startId) };
  } catch {
    // A FAILED refine call must not read as "nothing more needed" (that would
    // silently conclude the turn). Return the stuck step unchanged: the retry
    // burns re-plan budget and the orchestrator escalates to the user.
    return { steps: stuckStep ? [{ id: stuckStep.id, task: stuckStep.task, parallel: false, agent: stuckStep.agent || 'auto' }] : [] };
  }
}

module.exports = { derivePlan, refinePlan, SUBMIT_PLAN_TOOL, DERIVE_PROMPT, REFINE_PROMPT };
