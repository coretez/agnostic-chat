'use strict';

// Provider-agnostic agentic loop: call the model; if it requests tools, run them
// and feed results back; repeat until a final text answer (or the iteration cap).
// `chat` and `callTool` are injected so this is unit-testable without a live model.

const { filterToolResult } = require('./filter');
const { compactToolHistory } = require('./tool-history');

/**
 * @param {object}   o
 * @param {function} o.chat      async ({model, messages, tools}) => {text, toolCalls:[{id,name,args}]}
 * @param {function} o.callTool  async (name, args) => {text, isError}
 * @param {string}   o.model
 * @param {Array}    o.messages  neutral history [{role, content, toolCalls?, toolCallId?}]
 * @param {Array}    o.tools     [{name, description, inputSchema}]
 * @param {number}  [o.maxIters=10]
 * @returns {Promise<{reply:string, toolTrace:Array, iterations:number}>}
 */
function createLoopState({ messages, maxIters, onEvent, isAborted }) {
  return {
    stopped: typeof isAborted === 'function' ? isAborted : () => false,
    emit: typeof onEvent === 'function' ? onEvent : () => {},
    history: [...messages], toolTrace: [], limit: maxIters, iterations: 0, truncated: false,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0, measured: false }
  };
}

function recordUsage(state, usage) {
  if (!usage) return;
  state.usage.measured = true;
  state.usage.calls += 1;
  state.usage.inputTokens += usage.inputTokens || 0;
  state.usage.outputTokens += usage.outputTokens || 0;
  state.usage.cachedTokens += usage.cachedTokens || 0;
  state.usage.cacheCreationTokens += usage.cacheCreationTokens || 0;
}

function recordTruncation(state, response) {
  if (!response?.truncated) return;
  state.truncated = true;
  state.emit({ type: 'process', kind: 'truncated', reason: response.finishReason || 'max_tokens' });
}

function stoppedResult(state, reply = '') {
  state.emit({ type: 'done' });
  return { reply, toolTrace: state.toolTrace, iterations: state.iterations, usage: state.usage, aborted: true };
}

async function hasIterationBudget(state, onLimit) {
  if (state.iterations < state.limit) return true;
  let additional = 0;
  if (typeof onLimit === 'function') {
    try { additional = Number(await onLimit({ iterations: state.iterations })) || 0; } catch {}
  }
  if (additional <= 0) return false;
  state.limit += additional;
  return true;
}

async function compactLoopHistory(state, compact) {
  const pruned = compactToolHistory(state.history);
  state.history = pruned.messages;
  if (pruned.stats.compacted) state.emit({ type: 'process', kind: 'tool-history-compact', ...pruned.stats });
  if (typeof compact === 'function') {
    try { state.history = await compact(state.history); } catch {}
  }
}

async function requestLoopResponse(state, chat, model, tools) {
  state.iterations += 1;
  state.emit({ type: 'model', model });
  try {
    const response = await chat({
      model, messages: state.history, tools,
      onDelta: (delta) => state.emit({ type: 'token', text: delta.text })
    });
    recordUsage(state, response.usage);
    recordTruncation(state, response);
    return response;
  } catch (error) {
    if (state.stopped()) return null;
    error.partial = { toolTrace: state.toolTrace, iterations: state.iterations, usage: state.usage };
    throw error;
  }
}

async function callAndRecordTool(state, callTool, call) {
  state.emit({ type: 'tool-start', name: call.name });
  const started = Date.now();
  let output;
  try { output = await callTool(call.name, call.args); }
  catch (error) { output = { text: `ERROR: ${error.message}`, isError: true }; }
  const durationMs = Date.now() - started;
  const rawLength = (output.text || '').length;
  const filtered = filterToolResult(call.name, output.text || '', { cap: 24000 });
  const truncated = filtered.rules.includes('middle-elide');
  const trace = { name: call.name, args: call.args, ok: !output.isError, resultChars: rawLength, filteredChars: filtered.after, rules: filtered.rules, truncated, durationMs };
  state.emit({ type: 'tool-end', ...trace });
  state.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: filtered.text });
  state.toolTrace.push(trace);
}

async function executeRequestedTools(state, callTool, response) {
  const calls = response.toolCalls || [];
  state.history.push({ role: 'assistant', content: response.text || '', toolCalls: calls, assistantRaw: response.assistantRaw });
  for (const call of calls) {
    if (state.stopped()) return false;
    await callAndRecordTool(state, callTool, call);
  }
  return true;
}

async function wrapUpCappedLoop(state, chat, model) {
  state.emit({ type: 'model', model });
  let response;
  try {
    response = await chat({
      model, tools: [],
      messages: [...state.history, { role: 'user', content: 'You have reached the tool-call limit — do NOT call any more tools. Using everything you have already gathered above, write your complete final answer now.' }],
      onDelta: (delta) => state.emit({ type: 'token', text: delta.text })
    });
    recordUsage(state, response.usage);
    recordTruncation(state, response);
  } catch (error) {
    state.emit({ type: 'process', kind: 'wrapup-failed', error: error?.message || 'model call failed' });
    response = { text: '' };
  }
  state.emit({ type: 'done' });
  return { reply: response.text || '(stopped after reaching the tool-call limit before a final answer could be produced)', toolTrace: state.toolTrace, iterations: state.iterations, usage: state.usage, cappedTurn: true, truncated: state.truncated };
}

async function runChatLoop(options) {
  const { chat, callTool, model, tools = [], maxIters = 10, onLimit, compact } = options;
  const state = createLoopState({ ...options, maxIters });
  while (await hasIterationBudget(state, onLimit)) {
    if (state.stopped()) return stoppedResult(state);
    await compactLoopHistory(state, compact);
    const response = await requestLoopResponse(state, chat, model, tools);
    if (!response) return stoppedResult(state);
    if (!(response.toolCalls || []).length) {
      state.emit({ type: 'done' });
      return { reply: response.text || '', toolTrace: state.toolTrace, iterations: state.iterations, usage: state.usage, truncated: state.truncated };
    }
    if (!(await executeRequestedTools(state, callTool, response))) return stoppedResult(state, response.text || '');
  }
  return wrapUpCappedLoop(state, chat, model);
}

module.exports = { runChatLoop };
