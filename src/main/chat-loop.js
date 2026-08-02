'use strict';

// Provider-agnostic agentic loop: call the model; if it requests tools, run them
// and feed results back; repeat until a final text answer (or the iteration cap).
// `chat` and `callTool` are injected so this is unit-testable without a live model.

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

  for (let i = 0; i < maxIters; i++) {
    emit({ type: 'model', model });
    const res = await chat({ model, messages: history, tools, onDelta: (d) => emit({ type: 'token', text: d.text }) });
    const calls = res.toolCalls || [];

    if (calls.length === 0) {
      emit({ type: 'done' });
      return { reply: res.text || '', toolTrace, iterations: i + 1 };
    }

    history.push({ role: 'assistant', content: res.text || '', toolCalls: calls, assistantRaw: res.assistantRaw });
    for (const call of calls) {
      emit({ type: 'tool-start', name: call.name });
      let out;
      try { out = await callTool(call.name, call.args); }
      catch (e) { out = { text: `ERROR: ${e.message}`, isError: true }; }
      emit({ type: 'tool-end', name: call.name, ok: !out.isError });
      // Guard: a giant tool result (e.g. skills_update dumping everything) must not
      // blow the model's context window when fed back.
      const CAP = 24000;
      let content = out.text || '';
      if (content.length > CAP) content = content.slice(0, CAP) + `\n…[truncated ${content.length - CAP} chars — tool returned too much to include in context]`;
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
      toolTrace.push({ name: call.name, args: call.args, ok: !out.isError });
    }
  }

  emit({ type: 'done' });
  return { reply: '(stopped after reaching the tool-call limit)', toolTrace, iterations: maxIters };
}

module.exports = { runChatLoop };
