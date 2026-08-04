'use strict';

// Step execution for the plan-and-execute turn model. A "step" is a scoped
// inner model↔tools loop (factored from chat-loop.js) that runs against the
// shared VariableStore: it captures discovered parameters as it goes, and a
// budget-exhausted step reports itself STUCK so the orchestrator can re-plan
// the remaining tail rather than dead-ending. See docs/PLANNING_ARCHITECTURE.md
// §6, §9 (decision #1), §11 (P1).
//
// Everything is injected (chat, callTool, refinePlan, onStuck) so the whole
// control flow is unit-testable without a live model.

const { filterToolResult } = require('./filter');
const { SET_VARIABLE_TOOL } = require('./variables');

const DEFAULT_STEP_BUDGET = 8;   // inner model↔tools iterations before a step is "stuck"
const REPLAN_BUDGET = 3;         // auto re-plans of a stuck step's tail before escalating (decision #1)

const STEP_WRAP_PROMPT =
  "You have reached this step's tool-call limit — do NOT call any more tools. " +
  'Summarize what you accomplished and what still remains for this step, using everything gathered above.';

// The step directive that opens each step: the always-present KNOWN VALUES
// block (instruction layer 5) followed by the concrete task. Re-injecting the
// store each step keeps discovered parameters in front of the model even after
// a mid-turn compaction.
function renderStepDirective(step, store) {
  const parts = [];
  const known = store && typeof store.render === 'function' ? store.render() : '';
  if (known) parts.push(known);
  parts.push(`CURRENT STEP (${step.id}): ${step.task}`);
  parts.push('Complete this step. When it is done, reply with your result and stop calling tools.');
  return parts.join('\n\n');
}

function makeUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0, measured: false };
}
function addUsage(usage, u) {
  if (!u) return;
  usage.measured = true; usage.calls += 1;
  usage.inputTokens += u.inputTokens || 0;
  usage.outputTokens += u.outputTokens || 0;
  usage.cachedTokens += u.cachedTokens || 0;
  usage.cacheCreationTokens += u.cacheCreationTokens || 0;
}

/**
 * Run one step to completion or to its budget.
 * @returns {Promise<{result:object, partial:string, history:Array, stuck:boolean,
 *                     reason?:string, usage:object, toolTrace:Array}>}
 */
async function executeStep({ chat, callTool, model, step, tools = [], history = [], store, budget = DEFAULT_STEP_BUDGET, onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const usage = makeUsage();
  const toolTrace = [];
  // The model always gets set_variable on top of the step's real tools.
  const stepTools = [SET_VARIABLE_TOOL, ...tools];
  const h = [...history, { role: 'user', content: renderStepDirective(step, store) }];

  emit({ type: 'process', kind: 'step-start', step: step.id, task: step.task });

  for (let i = 0; i < budget; i++) {
    emit({ type: 'model', model });
    const res = await chat({ model, messages: h, tools: stepTools, onDelta: (d) => emit({ type: 'token', text: d.text }) });
    addUsage(usage, res.usage);
    const calls = res.toolCalls || [];

    if (calls.length === 0) {
      emit({ type: 'process', kind: 'step-done', step: step.id });
      return { result: { step: step.id, task: step.task, conclusion: res.text || '', usage }, partial: res.text || '', history: h, stuck: false, usage, toolTrace };
    }

    h.push({ role: 'assistant', content: res.text || '', toolCalls: calls, assistantRaw: res.assistantRaw });
    for (const call of calls) {
      // Explicit capture — intercepted here, NEVER routed to the MCP tool layer.
      if (call.name === 'set_variable') {
        const e = store ? store.set(
          { key: call.args && call.args.key, value: call.args && call.args.value, type: call.args && call.args.type },
          { confidence: 'derived', source: 'set_variable', step: step.id }
        ) : null;
        emit({ type: 'process', kind: 'var-set', step: step.id, key: e && e.key });
        h.push({ role: 'tool', toolCallId: call.id, name: 'set_variable', content: e ? `Remembered ${e.key} = ${JSON.stringify(e.value)}` : 'Ignored (empty key or value).' });
        toolTrace.push({ name: 'set_variable', args: call.args, ok: !!e });
        continue;
      }

      // Auto-capture the resolved parameters the model actually USED.
      if (store) for (const g of store.captureFromArgs(call.args, { step: step.id, source: call.name })) {
        emit({ type: 'process', kind: 'var-capture', step: step.id, key: g.key, from: 'args' });
      }

      emit({ type: 'tool-start', name: call.name });
      const t0 = Date.now();
      let out;
      try { out = await callTool(call.name, call.args); }
      catch (e) { out = { text: `ERROR: ${e.message}`, isError: true }; }
      const durationMs = Date.now() - t0;
      const rawLen = (out.text || '').length;

      // Auto-capture ids/paths from the RESULT before filtering can elide them.
      if (store && !out.isError) for (const g of store.captureFromResult(call.name, out.text || '', { step: step.id })) {
        emit({ type: 'process', kind: 'var-capture', step: step.id, key: g.key, from: 'result' });
      }

      const filt = filterToolResult(call.name, out.text || '', { cap: 24000 });
      emit({ type: 'tool-end', name: call.name, ok: !out.isError, resultChars: rawLen, filteredChars: filt.after, rules: filt.rules, durationMs });
      h.push({ role: 'tool', toolCallId: call.id, name: call.name, content: filt.text });
      toolTrace.push({ name: call.name, args: call.args, ok: !out.isError, resultChars: rawLen, filteredChars: filt.after, durationMs });
    }
  }

  // Budget exhausted without a natural stop → STUCK. Force a tool-less partial
  // conclusion so nothing gathered is lost, then hand control back so the
  // orchestrator can re-plan (decision #1).
  emit({ type: 'model', model });
  let wrap;
  try {
    wrap = await chat({ model, messages: [...h, { role: 'user', content: STEP_WRAP_PROMPT }], tools: [], onDelta: (d) => emit({ type: 'token', text: d.text }) });
    addUsage(usage, wrap.usage);
  } catch { wrap = { text: '' }; }
  emit({ type: 'process', kind: 'step-stuck', step: step.id });
  return {
    result: { step: step.id, task: step.task, conclusion: wrap.text || '', incomplete: true, usage },
    partial: wrap.text || '', history: h, stuck: true, reason: 'iteration-budget-exhausted', usage, toolTrace
  };
}

/**
 * Execute a plan's steps in order against the shared store, re-planning around
 * stuck steps and escalating to the user once the re-plan budget is spent
 * (decision #1). `refinePlan` and `onStuck` are injected; both optional.
 *
 * @param {object} o
 * @param {object} o.plan            {goal, steps:[{id, task, ...}]}
 * @param {object} o.store           VariableStore (shared across steps)
 * @param {function} [o.refinePlan]  async ({plan, done, stuckStep, reason, store}) => {steps:[...]}
 * @param {function} [o.onStuck]     async ({goal, done, stuckStep, values, replans}) => {continue:boolean}
 * @returns {Promise<{stepResults:Array, history:Array, replans:number, completed:boolean}>}
 */
async function executePlan({ chat, callTool, model, plan, tools = [], store, history = [], stepBudget = DEFAULT_STEP_BUDGET, replanBudget = REPLAN_BUDGET, refinePlan, onStuck, onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  let steps = [...((plan && plan.steps) || [])];
  const stepResults = [];
  let h = [...history];
  let replans = 0;
  let idx = 0;

  emit({ type: 'process', kind: 'execute-start', goal: plan && plan.goal, steps: steps.length });

  while (idx < steps.length) {
    const step = steps[idx];
    const r = await executeStep({ chat, callTool, model, step, tools, history: h, store, budget: stepBudget, onEvent: emit });
    h = r.history;

    if (r.stuck) {
      // Auto re-plan the remaining tail while we still have budget.
      if (replans < replanBudget && typeof refinePlan === 'function') {
        replans += 1;
        emit({ type: 'process', kind: 'replan', attempt: replans, step: step.id, reason: r.reason });
        let revised;
        try { revised = await refinePlan({ plan, done: stepResults, stuckStep: step, reason: r.reason, store }); }
        catch { revised = null; }
        const tail = revised && Array.isArray(revised.steps) ? revised.steps : [];
        steps = [...steps.slice(0, idx), ...tail];       // keep done prefix; replace remaining
        // If the re-plan decided nothing more is needed, keep the partial so the
        // stuck step's work still reaches synthesis.
        if (tail.length === 0) stepResults.push({ ...r.result, incomplete: true, note: 'replanned to completion' });
        continue;                                         // retry at idx against the revised tail
      }

      // Budget spent and still stuck → escalate to the user with an explanation.
      let decision = { continue: false };
      if (typeof onStuck === 'function') {
        emit({ type: 'process', kind: 'escalate', step: step.id, replans });
        try {
          decision = (await onStuck({
            goal: plan && plan.goal, done: stepResults, stuckStep: step,
            values: store && typeof store.render === 'function' ? store.render() : '', replans
          })) || { continue: false };
        } catch { decision = { continue: false }; }
      }
      if (decision.continue) { replans = 0; continue; }   // user granted a fresh budget

      stepResults.push({ ...r.result, incomplete: true });
      break;                                              // user declined → synthesize what we have
    }

    stepResults.push(r.result);
    idx += 1;
  }

  const completed = idx >= steps.length;
  emit({ type: 'process', kind: 'execute-done', steps: stepResults.length, replans, completed });
  return { stepResults, history: h, replans, completed };
}

module.exports = { executeStep, executePlan, renderStepDirective, DEFAULT_STEP_BUDGET, REPLAN_BUDGET, STEP_WRAP_PROMPT };
