'use strict';

// Step execution for the plan-and-execute turn model. A "step" is a scoped
// inner model↔tools loop (factored from chat-loop.js) that runs against the
// shared VariableStore: it captures discovered parameters as it goes, and a
// budget-exhausted step reports itself STUCK so the orchestrator can re-plan
// the remaining tail rather than dead-ending. See the internal planning-architecture record
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
  // The plan's declared outputs for this step — tells the model what to
  // discover AND what to record via set_variable for later steps.
  if (step.produces) parts.push(`THIS STEP MUST PRODUCE: ${step.produces}\nRecord produced values with set_variable so later steps can use them.`);
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
async function executeStep({ chat, callTool, model, step, tools = [], history = [], store, budget = DEFAULT_STEP_BUDGET, onEvent, isAborted }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const stopped = typeof isAborted === 'function' ? isAborted : () => false;
  const usage = makeUsage();
  const toolTrace = [];
  // The model always gets set_variable on top of the step's real tools.
  const stepTools = [SET_VARIABLE_TOOL, ...tools];
  const h = [...history, { role: 'user', content: renderStepDirective(step, store) }];

  emit({ type: 'process', kind: 'step-start', step: step.id, task: step.task });

  for (let i = 0; i < budget; i++) {
    // User STOP: no wrap-up model call (unlike a stuck step) — return what
    // this step has so far and let the orchestrator save the work.
    if (stopped()) return { result: { step: step.id, task: step.task, conclusion: '', incomplete: true, usage }, partial: '', history: h, stuck: false, aborted: true, usage, toolTrace };
    emit({ type: 'model', model });
    let res;
    try {
      res = await chat({ model, messages: h, tools: stepTools, onDelta: (d) => emit({ type: 'token', text: d.text }) });
    } catch (e) {
      if (stopped()) return { result: { step: step.id, task: step.task, conclusion: '', incomplete: true, usage }, partial: '', history: h, stuck: false, aborted: true, usage, toolTrace };
      throw e;
    }
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
 * @param {function} [o.compact]     async (history) => history — run between steps
 *   (wire to maybeCompress with protect: store.render() so the KNOWN VALUES
 *   digest structurally survives mid-turn compaction — P3)
 * @returns {Promise<{stepResults:Array, history:Array, replans:number, completed:boolean}>}
 */
async function executePlan({ chat, callTool, model, plan, tools = [], store, history = [], stepBudget = DEFAULT_STEP_BUDGET, replanBudget = REPLAN_BUDGET, refinePlan, onStuck, compact, runParallel, mergeGroup, onStepComplete, onEvent, isAborted }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const stopped = typeof isAborted === 'function' ? isAborted : () => false;
  // Post-step hook (O9 step-commits and the like): fired after a step's result
  // lands — completed, partial-on-stuck, and parallel alike — with the step's
  // own tool trace so the caller can tell whether anything actually mutated.
  // Best-effort: a throwing hook never breaks execution.
  const stepDone = async (step, result, trace) => {
    if (typeof onStepComplete !== 'function') return;
    try { await onStepComplete(step, result, trace || []); } catch {}
  };
  let steps = [...((plan && plan.steps) || [])];
  const stepResults = [];
  const toolTrace = [];
  const usage = makeUsage();
  const mergeUsage = (u) => { if (u && u.calls) { usage.measured = usage.measured || u.measured; usage.calls += u.calls; usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.cachedTokens += u.cachedTokens; usage.cacheCreationTokens += u.cacheCreationTokens; } };
  let h = [...history];
  let replans = 0;
  let idx = 0;

  emit({ type: 'process', kind: 'execute-start', goal: plan && plan.goal, steps: steps.length });

  while (idx < steps.length) {
    if (stopped()) break;   // user STOP: keep completed step results, save work
    const step = steps[idx];

    // O16: fan-out groups — CONSECUTIVE steps sharing a group run
    // CONCURRENTLY (≤4 in flight), then ONE merge produces a single
    // step-result the rest of the plan consumes via working memory. The
    // divider of work also owns the recombination (the internal design record §3).
    // A group counts as one step for budget purposes; a failed member
    // degrades to its error conclusion and the merge sees it; a failed
    // merge degrades to concatenation — the group can never break the turn.
    if (step.parallel && step.group && typeof runParallel === 'function') {
      const members = [step];
      while (idx + members.length < steps.length) {
        const n = steps[idx + members.length];
        if (n.parallel && n.group === step.group) members.push(n); else break;
      }
      if (members.length > 1) {
        emit({ type: 'process', kind: 'group-start', group: step.group, steps: members.map((m) => m.id) });
        const results = new Array(members.length);
        let cursor = 0;
        const worker = async () => {
          for (;;) {
            if (stopped()) return;
            const i = cursor++;
            if (i >= members.length) return;
            const m = members[i];
            emit({ type: 'process', kind: 'step-start', step: m.id, task: m.task, parallel: true, group: step.group });
            let pr;
            try { pr = await runParallel(m); }
            catch (e) { pr = { conclusion: `parallel step failed: ${e.message}`, error: true }; }
            results[i] = { step: m.id, task: m.task, conclusion: (pr && pr.conclusion) || '', error: !!(pr && pr.error) };
            emit({ type: 'process', kind: 'step-done', step: m.id, parallel: true });
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, members.length) }, worker));
        const ran = results.filter(Boolean);
        // Merge — one bounded call through the injected contract; absent or
        // failing merge falls back to a labeled concatenation.
        const concat = ran.map((r) => `### ${r.task}\n${r.conclusion || '(no result)'}`).join('\n\n');
        let merged = '';
        if (typeof mergeGroup === 'function' && ran.length && !stopped()) {
          try { merged = (await mergeGroup({ group: step.group, results: ran })) || ''; } catch {}
        }
        const conclusion = merged || concat;
        // Harvest ids/paths from the MERGED product into shared memory — this
        // is how later steps consume the group (KNOWN VALUES, not history).
        if (store && conclusion) store.captureFromResult(`group-${step.group}`, conclusion, { step: step.id });
        const gr = { step: step.id, task: `group "${step.group}" (${members.length} tasks)`, conclusion, parallel: true, group: step.group };
        stepResults.push(gr);
        emit({ type: 'process', kind: 'group-merged', group: step.group, members: ran.length, merged: !!merged, chars: conclusion.length });
        await stepDone({ ...step, task: gr.task }, gr, []);   // one step for bookkeeping
        idx += members.length;
        continue;
      }
    }

    // Parallel steps hand off to the decompose-and-merge sibling (subagent.js)
    // via the injected runner: an isolated sub-agent, no shared history — only
    // its conclusion (and any values captured from it) comes back (P5).
    if (step.parallel && typeof runParallel === 'function') {
      emit({ type: 'process', kind: 'step-start', step: step.id, task: step.task, parallel: true });
      let pr;
      try { pr = await runParallel(step); }
      catch (e) { pr = { conclusion: `parallel step failed: ${e.message}`, error: true }; }
      // Harvest ids/paths from the sub-agent's conclusion into shared memory.
      if (store && pr && pr.conclusion) store.captureFromResult(`step-${step.id}`, pr.conclusion, { step: step.id });
      const prResult = { step: step.id, task: step.task, conclusion: (pr && pr.conclusion) || '', parallel: true };
      stepResults.push(prResult);
      emit({ type: 'process', kind: 'step-done', step: step.id, parallel: true });
      await stepDone(step, prResult, []);  // sub-agent traces stay isolated — no mutation info
      idx += 1; continue;
    }

    const r = await executeStep({ chat, callTool, model, step, tools, history: h, store, budget: stepBudget, onEvent: emit, isAborted });
    h = r.history;
    mergeUsage(r.usage);
    toolTrace.push(...(r.toolTrace || []));
    if (r.aborted) { stepResults.push(r.result); break; }   // partial step kept for the save
    // Between-steps compaction (P3): the injected hook protects the store digest.
    if (typeof compact === 'function') { try { h = await compact(h); } catch {} }

    if (r.stuck) {
      // Auto re-plan the remaining tail while we still have budget.
      if (replans < replanBudget && typeof refinePlan === 'function') {
        replans += 1;
        emit({ type: 'process', kind: 'replan', attempt: replans, step: step.id, reason: r.reason });
        let revised;
        // r.partial rides along so the re-planner sees what the stuck step
        // half-found, not just that it stuck.
        try { revised = await refinePlan({ plan, done: stepResults, stuckStep: step, reason: r.reason, partial: r.partial, store }); }
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
      await stepDone(step, r.result, r.toolTrace);        // partial work is still worth recording
      break;                                              // user declined → synthesize what we have
    }

    stepResults.push(r.result);
    await stepDone(step, r.result, r.toolTrace);
    idx += 1;
  }

  const aborted = stopped();
  const completed = !aborted && idx >= steps.length;
  emit({ type: 'process', kind: 'execute-done', steps: stepResults.length, replans, completed, aborted });
  return { stepResults, history: h, replans, completed, usage, toolTrace, aborted };
}

/**
 * Final synthesis: one tool-less call over the goal, step results, and gathered
 * values. Guarantees the turn ends with a coherent answer even when execution
 * was partial (declined escalation keeps its partials for exactly this).
 */
async function synthesize({ chat, model, plan, stepResults = [], store, history = [], onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const mergeInstruction = (plan && typeof plan.merge === 'string' && plan.merge.trim()) ? plan.merge.trim() : '';
  if (stepResults.length === 1 && !stepResults[0].incomplete && !mergeInstruction) {
    // Single completed step with no merge contract — its conclusion IS the answer.
    return { reply: stepResults[0].conclusion || '', usage: null };
  }
  const digest = stepResults.map((r) =>
    `### Step ${r.step}: ${r.task}${r.incomplete ? ' (incomplete)' : ''}\n${r.conclusion || '(no result)'}`).join('\n\n');
  const known = store && typeof store.render === 'function' ? store.render() : '';
  const prompt =
    `All plan steps have finished. Write the complete final answer for the user now — do NOT call any tools.\n\n` +
    `GOAL: ${(plan && plan.goal) || ''}\n\n` +
    // The plan's own merge contract (how the combined answer should be
    // structured/presented) — authored at planning time, honored here.
    (mergeInstruction ? `HOW TO COMBINE THE RESULTS: ${mergeInstruction}\n\n` : '') +
    `${known ? known + '\n\n' : ''}STEP RESULTS:\n${digest}` +
    (stepResults.some((r) => r.incomplete) ? '\n\nSome steps are incomplete — say clearly what was accomplished and what remains.' : '');
  emit({ type: 'model', model });
  let res;
  try {
    res = await chat({ model, messages: [...history, { role: 'user', content: prompt }], tools: [], onDelta: (d) => emit({ type: 'token', text: d.text }) });
  } catch { res = { text: '' }; }
  return { reply: res.text || stepResults.map((r) => r.conclusion).filter(Boolean).join('\n\n') || '(no results produced)', usage: res.usage || null };
}

module.exports = { executeStep, executePlan, synthesize, renderStepDirective, DEFAULT_STEP_BUDGET, REPLAN_BUDGET, STEP_WRAP_PROMPT };
