'use strict';

// Provider-agnostic agentic loop: call the model; if it requests tools, run them
// and feed results back; repeat until a final text answer (or the iteration cap).
// `chat` and `callTool` are injected so this is unit-testable without a live model.

const { filterToolResult } = require('./filter');

/**
 * @param {object}   o
 * @param {function} o.chat      async ({model, messages, tools}) => {text, toolCalls:[{id,name,args}]}
 * @param {function} o.callTool  async (name, args) => {text, isError}
 * @param {string}   o.model
 * @param {Array}    o.messages  neutral history [{role, content, toolCalls?, toolCallId?}]
 * @param {Array}    o.tools     [{name, description, inputSchema}]
 * @param {number}  [o.maxIters=6]
 * @returns {Promise<{reply:string, toolTrace:Array, iterations:number}>}
 */
async function runChatLoop({ chat, callTool, model, messages, tools = [], maxIters = 6, onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const history = [...messages];
  const toolTrace = [];
  // Aggregate real provider token usage across every model call this turn.
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0, measured: false };
  const addUsage = (u) => {
    if (!u) return;
    usage.measured = true; usage.calls += 1;
    usage.inputTokens += u.inputTokens || 0;
    usage.outputTokens += u.outputTokens || 0;
    usage.cachedTokens += u.cachedTokens || 0;
    usage.cacheCreationTokens += u.cacheCreationTokens || 0;
  };

  for (let i = 0; i < maxIters; i++) {
    emit({ type: 'model', model });
    const res = await chat({ model, messages: history, tools, onDelta: (d) => emit({ type: 'token', text: d.text }) });
    addUsage(res.usage);
    const calls = res.toolCalls || [];

    if (calls.length === 0) {
      emit({ type: 'done' });
      return { reply: res.text || '', toolTrace, iterations: i + 1, usage };
    }

    history.push({ role: 'assistant', content: res.text || '', toolCalls: calls, assistantRaw: res.assistantRaw });
    for (const call of calls) {
      emit({ type: 'tool-start', name: call.name });
      let out;
      try { out = await callTool(call.name, call.args); }
      catch (e) { out = { text: `ERROR: ${e.message}`, isError: true }; }
      // Noise filter: strip low-signal bulk before the result re-enters context
      // (RTK-inspired). middle-elide is the backstop for anything still huge.
      const rawLen = (out.text || '').length;
      const filt = filterToolResult(call.name, out.text || '', { cap: 24000 });
      const content = filt.text;
      const truncated = filt.rules.includes('middle-elide');
      emit({ type: 'tool-end', name: call.name, ok: !out.isError, resultChars: rawLen, filteredChars: filt.after, rules: filt.rules, truncated });
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
      toolTrace.push({ name: call.name, args: call.args, ok: !out.isError, resultChars: rawLen, filteredChars: filt.after, rules: filt.rules, truncated });
    }
  }

  emit({ type: 'done' });
  return { reply: '(stopped after reaching the tool-call limit)', toolTrace, iterations: maxIters, usage };
}

module.exports = { runChatLoop };
