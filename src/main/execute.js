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
const { didMutate, MUTATING_TOOLS } = require('./coding-tools');
const { CODES, isTimeoutCode } = require('./providers/errors');

const DEFAULT_STEP_BUDGET = 8;   // inner model↔tools iterations before a step is "stuck"
const REPLAN_BUDGET = 3;         // auto re-plans of a stuck step's tail before escalating (decision #1)
const TRANSPORT_RETRIES = 2;     // same-step retries after a provider stall, before it counts as stuck

const STEP_WRAP_PROMPT =
  "You have reached this step's tool-call limit — do NOT call any more tools. " +
  'Summarize what you accomplished and what still remains for this step, using everything gathered above.';

// O26: the framework check gate. After a sequential step that mutated the
// tree, the injected check runs; a failure inserts ONE bounded fix step.
// Fix steps are exempt from insertion (they only RE-CHECK), so the gate can
// never spiral — a check still failing after its fix step is recorded and
// surfaced, not chased.

/**
 * A connector-side stall (idle timeout), as opposed to the user pressing STOP.
 *
 * Classified from a CODE, never from wording. The connectors set the code
 * where the cause is actually known; a first cut instead flattened that state
 * into a sentence and matched it back with /\baborted\b/i, which also caught
 * unrelated failures and silently retried them. An error arriving here with no
 * code and no AbortController signature is an UNKNOWN failure — it surfaces.
 */
function isProviderAbort(e) {
  if (!e) return false;
  // Read the CODE the connector set. The cause is known where it happens;
  // matching English here was a lossy round-trip that also swallowed
  // unrelated failures whose text merely contained "aborted".
  if (isTimeoutCode(e.code)) return true;
  if (e.code === CODES.USER_ABORT) return false;      // the user stopped — not a stall
  // Raw AbortController rejections that never passed through a connector
  // (e.g. a tool's own fetch). Still structural — name/code, never message.
  return e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 20;
}

// The step already proved it: its LAST mutating action was the check command
// itself, succeeding — nothing changed after that, so re-running is pure cost.
function alreadyVerified(trace, checkCommand) {
  if (!checkCommand) return false;
  const acts = (trace || []).filter((t) => MUTATING_TOOLS.includes(t.name));
  const last = acts[acts.length - 1];
  return !!last && last.ok !== false && last.name === 'run_command'
    && String((last.args && last.args.command) || '').trim() === String(checkCommand).trim();
}

function checkFixStep(step, output) {
  return {
    id: step.id + 0.1, _checkFix: true, agent: 'auto', parallel: false, group: '',
    produces: 'the project check command passing',
    task: 'The project check command FAILED after your last change:\n' + (output || '(no output)')
      + '\nFix the ROOT CAUSE so the check passes. NEVER delete, skip, or weaken a failing test to reach '
      + 'green; if a test itself is wrong, say so explicitly in your result.'
  };
}

async function gateStep({ step, trace, checkStep, checkCommand, steps, idx, emit }) {
  if (typeof checkStep !== 'function') return;
  // A fix step ALWAYS re-checks — the verdict is its whole point, even when
  // it claims done without touching a file. Ordinary steps only pay for a
  // check when they actually mutated.
  if (!step._checkFix && !didMutate(trace)) return;
  if (!step._checkFix && alreadyVerified(trace, checkCommand)) {
    emit({ type: 'process', kind: 'check-skipped', step: step.id, reason: 'step ran the check itself' });
    return;
  }
  const c = await checkStep(step);
  if (!c) return;
  // The runner already emitted the pass/fail verdict; this emits the GATE'S
  // DECISION only. Restating the verdict here double-logged every failure in
  // the process rail (seen driving a real turn).
  if (c.ok) { if (step._checkFix) emit({ type: 'process', kind: 'check-fixed', step: step.id }); return; }
  if (step._checkFix) { emit({ type: 'process', kind: 'check-still-failing', step: step.id }); return; }
  emit({ type: 'process', kind: 'check-fix-inserted', step: step.id });
  steps.splice(idx + 1, 0, checkFixStep(step, c.output));
}

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
async function executeStep({ chat, callTool, model, step, tools = [], history = [], store, budget = DEFAULT_STEP_BUDGET, onEvent, isAborted, compact }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const stopped = typeof isAborted === 'function' ? isAborted : () => false;
  const usage = makeUsage();
  const toolTrace = [];
  let truncated = false;
  const noteTruncation = (r) => {
    if (r && r.truncated) { truncated = true; emit({ type: 'process', kind: 'truncated', step: step.id, reason: r.finishReason || 'max_tokens' }); }
  };
  // The model always gets set_variable on top of the step's real tools.
  const stepTools = [SET_VARIABLE_TOOL, ...tools];
  let h = [...history, { role: 'user', content: renderStepDirective(step, store) }];

  emit({ type: 'process', kind: 'step-start', step: step.id, task: step.task });

  for (let i = 0; i < budget; i++) {
    // User STOP: no wrap-up model call (unlike a stuck step) — return what
    // this step has so far and let the orchestrator save the work.
    if (stopped()) return { result: { step: step.id, task: step.task, conclusion: '', incomplete: true, usage }, partial: '', history: h, stuck: false, aborted: true, usage, toolTrace };
    // In-loop ledger: a step's own tool results can overflow the window before
    // the between-steps compact ever runs (threshold-gated, cheap when under).
    if (typeof compact === 'function') { try { h = await compact(h); } catch {} }
    emit({ type: 'model', model });
    let res;
    try {
      res = await chat({ model, messages: h, tools: stepTools, onDelta: (d) => emit({ type: 'token', text: d.text }) });
    } catch (e) {
      if (stopped()) return { result: { step: step.id, task: step.task, conclusion: '', incomplete: true, usage }, partial: '', history: h, stuck: false, aborted: true, usage, toolTrace };
      // A PROVIDER-side abort (the connector's idle timer firing on a model
      // that went quiet) is a stalled provider, not a broken plan. It used to
      // re-throw and kill the whole turn — every completed step, the
      // synthesis, and the persistence went with it, against O12's promise
      // that every failure lands somewhere safer. Degrade to STUCK so the
      // bounded refine/escalate path handles it and finished work survives.
      // No wrap-up call here: the provider that just timed out cannot
      // summarize anything.
      if (isProviderAbort(e)) {
        emit({ type: 'process', kind: 'provider-timeout', step: step.id });
        return {
          result: { step: step.id, task: step.task, conclusion: '', incomplete: true, usage },
          partial: '', history: h, stuck: true, reason: 'provider-timeout', usage, toolTrace
        };
      }
      throw e;
    }
    addUsage(usage, res.usage);
    noteTruncation(res);
    const calls = res.toolCalls || [];

    if (calls.length === 0) {
      emit({ type: 'process', kind: 'step-done', step: step.id });
      return { result: { step: step.id, task: step.task, conclusion: res.text || '', usage }, partial: res.text || '', history: h, stuck: false, usage, toolTrace, truncated };
    }

    h.push({ role: 'assistant', content: res.text || '', toolCalls: calls, assistantRaw: res.assistantRaw });
    for (const call of calls) {
      // Explicit capture — intercepted here, NEVER routed to the MCP tool layer.
      if (call.name === 'set_variable') {
        const e = store ? store.set(
          { key: call.args && call.args.key, value: call.args && call.args.value, type: call.args && call.args.type },
          { confidence: 'derived', source: 'set_variable', step: step.id }
        ) : null;
        // The store REFUSES empty keys/values and non-scalars. Reporting those
        // as `var-set` (with key: null) told the glass box five captures had
        // happened when none had — the same lie the record filter used to
        // tell. Say which actually happened.
        emit(e
          ? { type: 'process', kind: 'var-set', step: step.id, key: e.key, confidence: e.confidence }
          : { type: 'process', kind: 'var-rejected', step: step.id, key: (call.args && call.args.key) || '(empty)' });
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
    noteTruncation(wrap);
  } catch (e) {
    emit({ type: 'process', kind: 'wrapup-failed', step: step.id, error: (e && e.message) || 'model call failed' });
    wrap = { text: '' };
  }
  emit({ type: 'process', kind: 'step-stuck', step: step.id });
  return {
    result: { step: step.id, task: step.task, conclusion: wrap.text || '', incomplete: true, usage },
    partial: wrap.text || '', history: h, stuck: true, reason: 'iteration-budget-exhausted', usage, toolTrace, truncated
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
async function executePlan({ chat, callTool, model, plan, tools = [], store, history = [], stepBudget = DEFAULT_STEP_BUDGET, replanBudget = REPLAN_BUDGET, refinePlan, onStuck, compact, runParallel, mergeGroup, onStepComplete, checkStep, checkCommand = '', onEvent, isAborted }) {
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
  const plannedIds = steps.map((s) => s.id);   // the plan as promised, before any re-plan
  const stepResults = [];
  const toolTrace = [];
  const usage = makeUsage();
  const mergeUsage = (u) => { if (u && u.calls) { usage.measured = usage.measured || u.measured; usage.calls += u.calls; usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.cachedTokens += u.cachedTokens; usage.cacheCreationTokens += u.cacheCreationTokens; } };
  let h = [...history];
  let replans = 0;
  let idx = 0;
  // Per-step transport retries (a stalled provider is retried, never replanned).
  let transportRetries = 0;
  let transportIdx = -1;
  let truncated = false; // any step's model output hit the token limit

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

    const r = await executeStep({ chat, callTool, model, step, tools, history: h, store, budget: stepBudget, onEvent: emit, isAborted, compact });
    h = r.history;
    truncated = truncated || !!r.truncated;
    mergeUsage(r.usage);
    toolTrace.push(...(r.toolTrace || []));
    if (r.aborted) { stepResults.push(r.result); break; }   // partial step kept for the save
    // Between-steps compaction (P3): the injected hook protects the store digest.
    if (typeof compact === 'function') { try { h = await compact(h); } catch {} }

    if (r.stuck) {
      // A TRANSPORT failure says nothing about the plan. Re-deriving the tail
      // in response to a stalled provider is a category error: the replan
      // REPLACES every remaining step, and on 2026-08-14 that silently
      // deleted the steps that wrote the deliverable — the turn then reported
      // success having produced nothing. Retry the SAME step instead and keep
      // the plan intact; only genuine task-level stuckness earns a re-plan.
      if (r.reason === 'provider-timeout') {
        if (transportIdx !== idx) { transportIdx = idx; transportRetries = 0; }
        if (transportRetries < TRANSPORT_RETRIES) {
          transportRetries += 1;
          emit({ type: 'process', kind: 'transport-retry', step: step.id, attempt: transportRetries });
          continue;                                    // same idx, same steps — plan preserved
        }
      }
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
    // O26: the check gate runs AFTER bookkeeping (the step's own commit stands;
    // a fix step earns its own commit) and only on the sequential path —
    // sub-agent traces are isolated, so gating them here would be blind.
    if (!stopped()) { try { await gateStep({ step, trace: r.toolTrace, checkStep, checkCommand, steps, idx, emit }); } catch {} }
    idx += 1;
  }

  const aborted = stopped();
  const completed = !aborted && idx >= steps.length;
  // Plan attrition (deterministic, no heuristics): which steps the plan opened
  // with never ran. A re-plan legitimately rewrites the tail, but on
  // 2026-08-14 one silently removed the steps that wrote the deliverable and
  // the turn still reported success. Counting is not judging — the fact is
  // surfaced and synthesis can say so.
  const ranIds = new Set(stepResults.map((r) => r.step));
  const skipped = plannedIds.filter((id) => !ranIds.has(id));
  if (completed && skipped.length) {
    emit({ type: 'process', kind: 'plan-shrank', planned: plannedIds.length, ran: ranIds.size, skipped });
  }
  emit({ type: 'process', kind: 'execute-done', steps: stepResults.length, replans, completed, aborted });
  return { stepResults, history: h, replans, completed, usage, toolTrace, aborted, truncated, skipped };
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
    if (res.truncated) emit({ type: 'process', kind: 'truncated', reason: res.finishReason || 'max_tokens' });
  } catch (e) {
    emit({ type: 'process', kind: 'synthesis-failed', error: (e && e.message) || 'model call failed' });
    res = { text: '' };
  }
  return { reply: res.text || stepResults.map((r) => r.conclusion).filter(Boolean).join('\n\n') || '(no results produced)', usage: res.usage || null, truncated: !!res.truncated };
}

module.exports = { executeStep, executePlan, synthesize, renderStepDirective, alreadyVerified, isProviderAbort, DEFAULT_STEP_BUDGET, REPLAN_BUDGET, TRANSPORT_RETRIES, STEP_WRAP_PROMPT };
