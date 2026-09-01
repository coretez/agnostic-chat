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
const { compactToolHistory } = require('./tool-history');

const DEFAULT_STEP_BUDGET = 8;   // inner model↔tools iterations before a step is "stuck"
const REPLAN_BUDGET = 3;         // auto re-plans of a stuck step's tail before escalating (decision #1)
const TRANSPORT_RETRIES = 1;     // provider layer already retries; one harness retry avoids multiplicative outages

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
  if (step.produces) parts.push(`THIS STEP MUST PRODUCE: ${step.produces}\nReturn these outputs in your final step result. Use set_variable ONLY for reusable scalar identifiers, paths, numbers, or short strings. Never use set_variable for objects, arrays, evidence bundles, drafts, plans, or long prose; your final step result is automatically passed to the next step.`);
  parts.push('Reuse evidence already present in this turn. Do not repeat an identical read-only tool call unless the user explicitly requested a refresh.');
  parts.push('The user request, workflow contract, and CURRENT STEP are the requirements. A validator or helper you create may verify them, but must not invent new mandatory content or silently expand acceptance. If a self-authored check is stricter than the stated requirements, correct the check instead of changing the deliverable to satisfy the invented rule.');
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

function reconcileRefinedSteps(revised, done = []) {
  const proposed = revised && Array.isArray(revised.steps) ? revised.steps : [];
  const completed = new Set(done.map((row) => String(row.step)));
  const steps = proposed.filter((step) => !completed.has(String(step.id)));
  return { steps, proposed: proposed.length, droppedCompleted: proposed.length - steps.length };
}

/**
 * Run one step to completion or to its budget.
 * @returns {Promise<{result:object, partial:string, history:Array, stuck:boolean,
 *                     reason?:string, usage:object, toolTrace:Array}>}
 */
function createStepExecution(options) {
  const context = {
    tools: [], history: [], budget: DEFAULT_STEP_BUDGET,
    maxDurationMs: 0, ...options
  };
  context.emit = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  context.stopped = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  context.usage = makeUsage(); context.toolTrace = []; context.truncated = false;
  context.startedAt = Date.now();
  context.history = [...context.history, { role: 'user', content: renderStepDirective(context.step, context.store) }];
  return context;
}

function stepResult(context, conclusion, additions = {}) {
  return {
    result: { step: context.step.id, task: context.step.task, conclusion, usage: context.usage, ...(additions.incomplete ? { incomplete: true } : {}) },
    partial: conclusion, history: context.history, usage: context.usage,
    toolTrace: context.toolTrace, truncated: context.truncated, ...additions
  };
}

function deadlineStepResult(context) {
  const durationMs = Date.now() - context.startedAt;
  const partial = `Step paused after reaching its ${Math.round(context.maxDurationMs / 1000)}s wall-clock budget; ${context.toolTrace.length} tool action(s) were preserved.`;
  context.emit({ type: 'process', kind: 'step-deadline', step: context.step.id, durationMs });
  return stepResult(context, partial, { incomplete: true, stuck: true, reason: 'provider-budget-exhausted' });
}

function recordStepTruncation(context, response) {
  if (response && response.truncated) {
    context.truncated = true;
    context.emit({ type: 'process', kind: 'truncated', step: context.step.id, reason: response.finishReason || 'max_tokens', discardedToolCalls: response.discardedToolCalls || 0 });
  }
  if (response && response.malformedToolCalls) context.emit({ type: 'process', kind: 'malformed-tool-call', step: context.step.id, discardedToolCalls: response.malformedToolCalls });
}

async function compactStepHistory(context) {
  const pruned = compactToolHistory(context.history); context.history = pruned.messages;
  if (pruned.stats.compacted) context.emit({ type: 'process', kind: 'tool-history-compact', step: context.step.id, ...pruned.stats });
  if (typeof context.compact === 'function') { try { context.history = await context.compact(context.history); } catch {} }
}

async function callStepModel(context) {
  const controller = context.maxDurationMs > 0 ? new AbortController() : null;
  const remaining = controller ? Math.max(1, context.maxDurationMs - (Date.now() - context.startedAt)) : 0;
  const timer = controller ? setTimeout(() => controller.abort(), remaining) : null;
  try {
    const response = await context.chat({ model: context.model, messages: context.history, tools: [SET_VARIABLE_TOOL, ...context.tools], maxTokens: context.maxTokens, signal: controller && controller.signal, onDelta: (delta) => context.emit({ type: 'token', text: delta.text }) });
    return { response };
  } catch (error) { return { error, deadline: !!(controller && controller.signal.aborted) }; }
  finally { if (timer) clearTimeout(timer); }
}

function handleStepModelError(context, modelCall, iteration) {
  if (context.stopped()) return stepResult(context, '', { incomplete: true, stuck: false, aborted: true });
  if (modelCall.deadline) return deadlineStepResult(context);
  if (isProviderAbort(modelCall.error)) {
    context.emit({ type: 'process', kind: 'provider-timeout', step: context.step.id });
    return stepResult(context, '', { incomplete: true, stuck: true, reason: 'provider-timeout' });
  }
  modelCall.error.partial = { toolTrace: [...context.toolTrace], iterations: iteration, usage: context.usage };
  throw modelCall.error;
}

function finishStepWithoutTools(context, response) {
  if ((response.toolCalls || []).length) return null;
  if (response.truncated || response.discardedToolCalls) {
    const partial = response.text || '';
    if (partial) context.history.push({ role: 'assistant', content: partial });
    const reason = response.truncated ? 'output-truncated' : 'malformed-tool-call';
    context.emit({ type: 'process', kind: 'step-stuck', step: context.step.id, reason });
    return stepResult(context, partial, { incomplete: true, stuck: true, reason });
  }
  if (response.text) context.history.push({ role: 'assistant', content: response.text });
  context.emit({ type: 'process', kind: 'step-done', step: context.step.id });
  return stepResult(context, response.text || '', { stuck: false });
}

function storeExplicitVariable(context, call) {
  const entry = context.store ? context.store.set(
    { key: call.args && call.args.key, value: call.args && call.args.value, type: call.args && call.args.type },
    { confidence: 'derived', source: 'set_variable', step: context.step.id }
  ) : null;
  context.emit(entry
    ? { type: 'process', kind: 'var-set', step: context.step.id, key: entry.key, confidence: entry.confidence }
    : { type: 'process', kind: 'var-rejected', step: context.step.id, key: (call.args && call.args.key) || '(empty)' });
  context.history.push({ role: 'tool', toolCallId: call.id, name: 'set_variable', content: entry ? `Remembered ${entry.key} = ${JSON.stringify(entry.value)}` : 'Ignored (empty key or value).' });
  context.toolTrace.push({ name: 'set_variable', args: call.args, ok: !!entry });
}

function captureStepArguments(context, call) {
  if (!context.store) return;
  for (const captured of context.store.captureFromArgs(call.args, { step: context.step.id, source: call.name })) {
    context.emit({ type: 'process', kind: 'var-capture', step: context.step.id, key: captured.key, from: 'args' });
  }
}

function captureStepResult(context, call, output) {
  if (!context.store || output.isError) return;
  for (const captured of context.store.captureFromResult(call.name, output.text || '', { step: context.step.id })) {
    context.emit({ type: 'process', kind: 'var-capture', step: context.step.id, key: captured.key, from: 'result' });
  }
}

async function runStepTool(context, call) {
  captureStepArguments(context, call); context.emit({ type: 'tool-start', name: call.name });
  const startedAt = Date.now();
  let output;
  try { output = await context.callTool(call.name, call.args); }
  catch (error) { output = { text: `ERROR: ${error.message}`, isError: true }; }
  const durationMs = Date.now() - startedAt; const resultChars = (output.text || '').length;
  captureStepResult(context, call, output);
  const filtered = filterToolResult(call.name, output.text || '', { cap: 24000 });
  context.emit({ type: 'tool-end', name: call.name, ok: !output.isError, resultChars, filteredChars: filtered.after, rules: filtered.rules, durationMs });
  context.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: filtered.text });
  context.toolTrace.push({ name: call.name, args: call.args, ok: !output.isError, resultChars, filteredChars: filtered.after, durationMs });
}

async function runStepToolCalls(context, response) {
  const calls = response.toolCalls || [];
  context.history.push({ role: 'assistant', content: response.text || '', toolCalls: calls, assistantRaw: response.assistantRaw });
  for (const call of calls) {
    if (call.name === 'set_variable') storeExplicitVariable(context, call);
    else await runStepTool(context, call);
  }
}

async function wrapExhaustedStep(context) {
  context.emit({ type: 'model', model: context.model });
  let response;
  try {
    response = await context.chat({ model: context.model, messages: [...context.history, { role: 'user', content: STEP_WRAP_PROMPT }], tools: [], maxTokens: context.maxTokens, onDelta: (delta) => context.emit({ type: 'token', text: delta.text }) });
    addUsage(context.usage, response.usage); recordStepTruncation(context, response);
  } catch (error) {
    context.emit({ type: 'process', kind: 'wrapup-failed', step: context.step.id, error: (error && error.message) || 'model call failed' });
    response = { text: '' };
  }
  context.emit({ type: 'process', kind: 'step-stuck', step: context.step.id });
  return stepResult(context, response.text || '', { incomplete: true, stuck: true, reason: 'iteration-budget-exhausted' });
}

async function executeStep(options) {
  const context = createStepExecution(options);
  context.emit({ type: 'process', kind: 'step-start', step: context.step.id, task: context.step.task });
  for (let iteration = 0; iteration < context.budget; iteration++) {
    if (context.stopped()) return stepResult(context, '', { incomplete: true, stuck: false, aborted: true });
    if (context.maxDurationMs > 0 && Date.now() - context.startedAt >= context.maxDurationMs) return deadlineStepResult(context);
    await compactStepHistory(context); context.emit({ type: 'model', model: context.model });
    const modelCall = await callStepModel(context);
    if (modelCall.error) return handleStepModelError(context, modelCall, iteration);
    addUsage(context.usage, modelCall.response.usage); recordStepTruncation(context, modelCall.response);
    const finished = finishStepWithoutTools(context, modelCall.response);
    if (finished) return finished;
    await runStepToolCalls(context, modelCall.response);
  }
  return wrapExhaustedStep(context);
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
function createPlanExecution(options) {
  const context = { tools: [], history: [], stepBudget: DEFAULT_STEP_BUDGET, maxStepDurationMs: 0, replanBudget: REPLAN_BUDGET, checkCommand: '', ...options };
  context.emit = typeof context.onEvent === 'function' ? context.onEvent : () => {};
  context.stopped = typeof context.isAborted === 'function' ? context.isAborted : () => false;
  context.steps = [...((context.plan && context.plan.steps) || [])];
  context.plannedIds = context.steps.map((step) => step.id); context.replacedIds = new Set();
  context.stepResults = []; context.toolTrace = []; context.delegatedToolTrace = [];
  context.attemptTrace = new Map(); context.replanAttempts = new Map(); context.usage = makeUsage();
  context.history = [...context.history]; context.idx = 0; context.replans = 0;
  context.transportIdx = -1; context.transportRetries = 0; context.truncated = false; context.terminalReason = null;
  return context;
}

function mergePlanUsage(context, usage) {
  if (!usage || !usage.calls) return;
  context.usage.measured = context.usage.measured || usage.measured;
  context.usage.calls += usage.calls; context.usage.inputTokens += usage.inputTokens;
  context.usage.outputTokens += usage.outputTokens; context.usage.cachedTokens += usage.cachedTokens;
  context.usage.cacheCreationTokens += usage.cacheCreationTokens;
}

async function completePlanStep(context, step, result, trace = []) {
  if (typeof context.onStepComplete !== 'function') return;
  try { await context.onStepComplete(step, result, trace); } catch {}
}

function groupedParallelSteps(context, step) {
  if (!step.parallel || !step.group || typeof context.runParallel !== 'function') return [];
  const members = [step];
  while (context.idx + members.length < context.steps.length) {
    const candidate = context.steps[context.idx + members.length];
    if (!candidate.parallel || candidate.group !== step.group) break;
    members.push(candidate);
  }
  return members.length > 1 ? members : [];
}

async function runParallelWorker(context, members, results, cursor) {
  for (;;) {
    if (context.stopped()) return;
    const index = cursor.value++;
    if (index >= members.length) return;
    const member = members[index];
    context.emit({ type: 'process', kind: 'step-start', step: member.id, task: member.task, parallel: true, group: member.group });
    let output;
    try { output = await context.runParallel(member, { history: context.history }); }
    catch (error) { output = { conclusion: `parallel step failed: ${error.message}`, error: true }; }
    if (output && Array.isArray(output.toolTrace)) context.delegatedToolTrace.push(...output.toolTrace);
    results[index] = { step: member.id, task: member.task, conclusion: (output && output.conclusion) || '', error: !!(output && output.error), toolTrace: (output && output.toolTrace) || [] };
    context.emit({ type: 'process', kind: 'step-done', step: member.id, parallel: true });
  }
}

async function mergeParallelGroup(context, step, results) {
  const fallback = results.map((result) => `### ${result.task}\n${result.conclusion || '(no result)'}`).join('\n\n');
  if (typeof context.mergeGroup !== 'function' || !results.length || context.stopped()) return { conclusion: fallback, merged: false };
  let merged = '';
  try { merged = (await context.mergeGroup({ group: step.group, results })) || ''; } catch {}
  return { conclusion: merged || fallback, merged: !!merged };
}

async function recordParallelGroup(context, step, members, results, merged) {
  const memberIds = members.map((member) => member.id);
  context.history.push({ role: 'assistant', content: `DELEGATED GROUP RESULT (${step.group}; steps ${memberIds.join(', ')}):\n${merged.conclusion}` });
  if (context.store && merged.conclusion) context.store.captureFromResult(`group-${step.group}`, merged.conclusion, { step: step.id });
  const groupResult = { step: step.id, task: `group "${step.group}" (${members.length} tasks)`, conclusion: merged.conclusion, parallel: true, group: step.group, memberSteps: memberIds };
  context.stepResults.push(groupResult);
  context.emit({ type: 'process', kind: 'group-merged', group: step.group, members: results.length, merged: merged.merged, chars: merged.conclusion.length });
  for (const result of results.slice(1)) {
    const member = members.find((candidate) => String(candidate.id) === String(result.step));
    if (member) await completePlanStep(context, member, { ...result, parallel: true, group: step.group }, result.toolTrace || []);
  }
  const groupTrace = results.flatMap((result) => result.toolTrace || []);
  await completePlanStep(context, { ...step, task: groupResult.task }, groupResult, groupTrace);
}

async function runParallelGroup(context, step) {
  const members = groupedParallelSteps(context, step);
  if (!members.length) return false;
  context.emit({ type: 'process', kind: 'group-start', group: step.group, steps: members.map((member) => member.id) });
  const results = new Array(members.length); const cursor = { value: 0 };
  const workers = Array.from({ length: Math.min(4, members.length) }, () => runParallelWorker(context, members, results, cursor));
  await Promise.all(workers);
  const completed = results.filter(Boolean);
  await recordParallelGroup(context, step, members, completed, await mergeParallelGroup(context, step, completed));
  context.idx += members.length;
  return true;
}

async function runSingleParallelStep(context, step) {
  if (!step.parallel || typeof context.runParallel !== 'function') return false;
  context.emit({ type: 'process', kind: 'step-start', step: step.id, task: step.task, parallel: true });
  let output;
  try { output = await context.runParallel(step, { history: context.history }); }
  catch (error) { output = { conclusion: `parallel step failed: ${error.message}`, error: true }; }
  if (context.store && output && output.conclusion) context.store.captureFromResult(`step-${step.id}`, output.conclusion, { step: step.id });
  if (output && Array.isArray(output.toolTrace)) context.delegatedToolTrace.push(...output.toolTrace);
  const result = { step: step.id, task: step.task, conclusion: (output && output.conclusion) || '', parallel: true };
  context.stepResults.push(result); context.history.push({ role: 'assistant', content: `DELEGATED STEP ${step.id} RESULT:\n${result.conclusion}` });
  context.emit({ type: 'process', kind: 'step-done', step: step.id, parallel: true });
  await completePlanStep(context, step, result); context.idx += 1;
  return true;
}

async function runSequentialStep(context, step) {
  try {
    return await executeStep({ chat: context.chat, callTool: context.callTool, model: context.model, step, tools: context.tools, history: context.history, store: context.store, budget: context.stepBudget, maxTokens: context.maxStepOutputTokens, maxDurationMs: context.maxStepDurationMs, onEvent: context.emit, isAborted: context.isAborted, compact: context.compact });
  } catch (error) {
    mergePlanUsage(context, error.partial && error.partial.usage);
    error.partial = { toolTrace: [...context.toolTrace, ...((error.partial && error.partial.toolTrace) || [])], iterations: context.stepResults.length, usage: context.usage };
    throw error;
  }
}

async function recordSequentialAttempt(context, step, attempt) {
  context.history = attempt.history; context.truncated = context.truncated || !!attempt.truncated;
  mergePlanUsage(context, attempt.usage); context.toolTrace.push(...(attempt.toolTrace || []));
  const key = String(step.id);
  context.attemptTrace.set(key, [...(context.attemptTrace.get(key) || []), ...(attempt.toolTrace || [])]);
  if (attempt.aborted) { context.stepResults.push(attempt.result); return false; }
  if (typeof context.compact === 'function') { try { context.history = await context.compact(context.history); } catch {} }
  return true;
}

function retryProviderTimeout(context, step, attempt) {
  if (attempt.reason !== 'provider-timeout') return false;
  if (context.transportIdx !== context.idx) { context.transportIdx = context.idx; context.transportRetries = 0; }
  if (context.transportRetries >= TRANSPORT_RETRIES) return false;
  context.transportRetries += 1;
  context.emit({ type: 'process', kind: 'transport-retry', step: step.id, attempt: context.transportRetries });
  context.history.push({ role: 'system', content: `RECOVERY CHECKPOINT: step ${step.id} stalled after tool work. Reuse every result already above; do not repeat completed retrieval or side effects. Continue from the unfinished boundary.` });
  return true;
}

async function refineStuckPlan(context, step, attempt, stepReplans) {
  const ineligible = ['provider-timeout', 'provider-budget-exhausted'].includes(attempt.reason);
  if (ineligible || stepReplans >= context.replanBudget || typeof context.refinePlan !== 'function') return false;
  context.replanAttempts.set(String(step.id), stepReplans + 1); context.replans += 1;
  context.emit({ type: 'process', kind: 'replan', attempt: stepReplans + 1, total: context.replans, step: step.id, reason: attempt.reason });
  let revised;
  try { revised = await context.refinePlan({ plan: context.plan, done: context.stepResults, stuckStep: step, reason: attempt.reason, partial: attempt.partial, store: context.store }); }
  catch { revised = null; }
  const reconciled = reconcileRefinedSteps(revised, context.stepResults); const tail = reconciled.steps;
  const revisedIds = new Set(tail.map((candidate) => String(candidate.id)));
  for (const candidate of context.steps.slice(context.idx)) if (!revisedIds.has(String(candidate.id))) context.replacedIds.add(String(candidate.id));
  context.emit({ type: 'process', kind: 'replan-resume', step: step.id, proposed: reconciled.proposed, droppedCompleted: reconciled.droppedCompleted, remaining: tail.length });
  context.steps = [...context.steps.slice(0, context.idx), ...tail];
  if (!tail.length) context.stepResults.push({ ...attempt.result, incomplete: true, note: 'replanned to completion' });
  return true;
}

async function escalateStuckPlan(context, step, attempt, stepReplans) {
  let decision = { continue: false };
  if (typeof context.onStuck === 'function') {
    context.emit({ type: 'process', kind: 'escalate', step: step.id, replans: context.replans });
    try {
      decision = (await context.onStuck({ goal: context.plan && context.plan.goal, done: context.stepResults, stuckStep: step, values: context.store && typeof context.store.render === 'function' ? context.store.render() : '', replans: stepReplans })) || decision;
    } catch {}
  }
  if (decision.continue) { context.replanAttempts.set(String(step.id), 0); return true; }
  context.stepResults.push({ ...attempt.result, incomplete: true }); context.terminalReason = attempt.reason || 'stuck';
  await completePlanStep(context, step, attempt.result, context.attemptTrace.get(String(step.id)) || attempt.toolTrace);
  return false;
}

async function handleStuckPlanStep(context, step, attempt) {
  if (retryProviderTimeout(context, step, attempt)) return true;
  const stepReplans = context.replanAttempts.get(String(step.id)) || 0;
  if (await refineStuckPlan(context, step, attempt, stepReplans)) return true;
  return escalateStuckPlan(context, step, attempt, stepReplans);
}

async function finishSequentialStep(context, step, attempt) {
  context.stepResults.push(attempt.result);
  await completePlanStep(context, step, attempt.result, context.attemptTrace.get(String(step.id)) || attempt.toolTrace);
  context.attemptTrace.delete(String(step.id));
  if (!context.stopped()) {
    try { await gateStep({ step, trace: attempt.toolTrace, checkStep: context.checkStep, checkCommand: context.checkCommand, steps: context.steps, idx: context.idx, emit: context.emit }); } catch {}
  }
  context.idx += 1;
}

async function runPlanIteration(context) {
  const step = context.steps[context.idx];
  if (await runParallelGroup(context, step)) return true;
  if (await runSingleParallelStep(context, step)) return true;
  const attempt = await runSequentialStep(context, step);
  if (!await recordSequentialAttempt(context, step, attempt)) return false;
  if (attempt.stuck) return handleStuckPlanStep(context, step, attempt);
  await finishSequentialStep(context, step, attempt);
  return true;
}

function planAttrition(context) {
  const ranIds = new Set();
  for (const result of context.stepResults) {
    ranIds.add(result.step);
    for (const member of (result.memberSteps || [])) ranIds.add(member);
  }
  const unrun = context.plannedIds.filter((id) => !ranIds.has(id));
  const skipped = unrun.filter((id) => context.replacedIds.has(String(id)));
  const pending = unrun.filter((id) => !context.replacedIds.has(String(id)));
  if (skipped.length) context.emit({ type: 'process', kind: 'plan-shrank', planned: context.plannedIds.length, ran: ranIds.size, skipped });
  return { skipped, pending };
}

function completedPlanResult(context) {
  const aborted = context.stopped(); const completed = !aborted && context.idx >= context.steps.length;
  const { skipped, pending } = planAttrition(context);
  context.emit({ type: 'process', kind: 'execute-done', steps: context.stepResults.length, replans: context.replans, completed, aborted });
  return { stepResults: context.stepResults, history: context.history, replans: context.replans, completed, usage: context.usage, toolTrace: context.toolTrace, delegatedToolTrace: context.delegatedToolTrace, aborted, truncated: context.truncated, skipped, pending, terminalReason: context.terminalReason };
}

async function executePlan(options) {
  const context = createPlanExecution(options);
  context.emit({ type: 'process', kind: 'execute-start', goal: context.plan && context.plan.goal, steps: context.steps.length });
  while (context.idx < context.steps.length && !context.stopped()) {
    if (!await runPlanIteration(context)) break;
  }
  return completedPlanResult(context);
}

function renderProviderPausedReply(stepResults = []) {
  const digest = stepResults.map((r) => `### Step ${r.step}: ${r.task}${r.incomplete ? ' (incomplete)' : ''}\n${r.conclusion || '(no result)'}`).join('\n\n');
  return 'Workflow paused because the model provider exceeded its bounded response time. Completed work and checkpoints were saved; resume will retry only the unfinished step.\n\n' + (digest || '(no completed step result)');
}

function planStatusResults({ skipped = [], pending = [], aborted = false } = {}) {
  if (aborted) return [];
  const rows = [];
  if (skipped.length) rows.push({ step: 'plan', task: 'planned steps removed by a revised plan', conclusion: `Original step IDs ${skipped.join(', ')} were replaced when the plan was revised. Compare their intended outcomes with the revised step results and saved artifacts.`, replaced: true });
  if (pending.length) rows.push({ step: 'plan-pending', task: 'planned steps not reached', incomplete: true, conclusion: `Original step IDs ${pending.join(', ')} remain pending because execution stopped before reaching them. They were not replaced by a revised plan and must not be described as completed.` });
  return rows;
}

/**
 * Final synthesis: one tool-less call over the goal, step results, and gathered
 * values. Guarantees the turn ends with a coherent answer even when execution
 * was partial (declined escalation keeps its partials for exactly this).
 */
function synthesisPrompt(plan, stepResults, store, mergeInstruction) {
  const digest = stepResults.map((r) =>
    `### Step ${r.step}: ${r.task}${r.incomplete ? ' (incomplete)' : ''}\n${r.conclusion || '(no result)'}`).join('\n\n');
  const known = store && typeof store.render === 'function' ? store.render() : '';
  return `All plan steps have finished. Write the complete final answer for the user now — do NOT call any tools.\n\n`
    + `GOAL: ${(plan && plan.goal) || ''}\n\n`
    + (mergeInstruction ? `HOW TO COMBINE THE RESULTS: ${mergeInstruction}\n\n` : '')
    + `${known ? known + '\n\n' : ''}STEP RESULTS:\n${digest}`
    + (stepResults.some((r) => r.incomplete) ? '\n\nSome steps are incomplete — say clearly what was accomplished and what remains.' : '');
}

async function requestSynthesis(chat, model, history, prompt, emit) {
  emit({ type: 'model', model });
  try {
    const response = await chat({
      model, messages: [...history, { role: 'user', content: prompt }], tools: [],
      onDelta: (delta) => emit({ type: 'token', text: delta.text })
    });
    if (response.truncated) emit({ type: 'process', kind: 'truncated', reason: response.finishReason || 'max_tokens' });
    return response;
  } catch (error) {
    emit({ type: 'process', kind: 'synthesis-failed', error: error?.message || 'model call failed' });
    return { text: '' };
  }
}

async function synthesize({ chat, model, plan, stepResults = [], store, history = [], onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const mergeInstruction = typeof plan?.merge === 'string' ? plan.merge.trim() : '';
  if (stepResults.length === 1 && !stepResults[0].incomplete && !mergeInstruction) {
    return { reply: stepResults[0].conclusion || '', usage: null };
  }
  const prompt = synthesisPrompt(plan, stepResults, store, mergeInstruction);
  const response = await requestSynthesis(chat, model, history, prompt, emit);
  const fallback = stepResults.map((result) => result.conclusion).filter(Boolean).join('\n\n');
  return { reply: response.text || fallback || '(no results produced)', usage: response.usage || null, truncated: !!response.truncated };
}

module.exports = { executeStep, executePlan, synthesize, renderProviderPausedReply, planStatusResults, renderStepDirective, reconcileRefinedSteps, alreadyVerified, isProviderAbort, DEFAULT_STEP_BUDGET, REPLAN_BUDGET, TRANSPORT_RETRIES, STEP_WRAP_PROMPT };
