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
  description: "Report the execution plan for the user's request as a structured series of steps plus how to merge their results.",
  inputSchema: {
    type: 'object',
    properties: {
      simple: { type: 'boolean', description: 'true if the request needs no multi-step plan (answer directly / a single tool call at most).' },
      goal: { type: 'string', description: 'One-line statement of what done looks like.' },
      steps: {
        type: 'array',
        description: 'Ordered steps. Each is a complete, self-contained JSON step object. Omit or leave empty when simple=true.',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Complete instruction for this step — executable on its own with the values known so far.' },
            produces: { type: 'string', description: 'What this step must yield for later steps: named values (e.g. "case_id, tenant_id") or an artifact ("the saved report path"). Drives working-memory capture.' },
            delegate: { type: 'boolean', description: 'true to run this step as an ISOLATED sub-agent: its bulk work stays out of the main context and only its conclusion returns. Use for self-contained research/pulls that would flood the main thread.' },
            agent: { type: 'string', description: 'For delegated steps: the named agent to use, or "auto" for a general sub-agent.' },
            parallel: { type: 'boolean', description: 'true only if this step does not depend on values discovered by its neighbors (delegated steps marked parallel may run concurrently).' }
          },
          required: ['task']
        }
      },
      merge: { type: 'string', description: "How to combine the step results into the final answer (structure, emphasis, format). Empty string if the last step's output IS the final answer." }
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
- For each step, state what it "produces" — the named values (ids, paths) or artifact later steps will need. Steps that discover identifiers come before steps that use them.
- DELEGATION: mark a step delegate=true when it is self-contained and would flood the main thread with bulk it doesn't need to keep (pulling a large report, sweeping many records) — an isolated sub-agent does the work and returns only its conclusion. Name a listed agent when one fits, else "auto". Mark delegated steps "parallel" only when they don't depend on each other's discoveries.
- MERGING: say in "merge" how the step results should be combined into the final answer (structure, format, emphasis) — or leave it empty if the last step's output IS the answer. If a skill above prescribes an output format, the merge instruction must follow it.

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
    .map((s, i) => ({
      id: startId + i,
      task: s.task.trim(),
      produces: typeof s.produces === 'string' ? s.produces.trim() : '',
      // A step runs isolated if the planner asked for delegation OR marked it
      // parallel (parallel execution requires isolation) — `parallel` stays
      // the executor's handoff flag for backward compatibility.
      parallel: !!(s.delegate || s.parallel),
      agent: s.agent || 'auto'
    }));
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
    const merge = typeof parsed.merge === 'string' ? parsed.merge.trim() : '';
    // A 0/1-step plan is the trivial-turn gate: nothing to orchestrate.
    if (parsed.simple || steps.length <= 1) return { simple: true, goal: parsed.goal || '', steps, merge };
    return { simple: false, goal: parsed.goal || '', steps, merge };
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
