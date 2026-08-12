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
 * @param {number}  [o.maxIters=10]
 * @returns {Promise<{reply:string, toolTrace:Array, iterations:number}>}
 */
async function runChatLoop({ chat, callTool, model, messages, tools = [], maxIters = 10, onEvent, onLimit, isAborted, compact }) {
  const stopped = typeof isAborted === 'function' ? isAborted : () => false;
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  let history = [...messages];
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

  let limit = maxIters;
  let i = 0;
  let truncated = false; // any model call this turn cut off by the output-token limit
  const noteTruncation = (r) => {
    if (r && r.truncated) { truncated = true; emit({ type: 'process', kind: 'truncated', reason: r.finishReason || 'max_tokens' }); }
  };
  for (;;) {
    // Hit the current tool-call budget. If a handler is wired (the interactive
    // chat), ask whether to keep going with a fresh budget; otherwise fall
    // through to the forced wrap-up below. Sub-agents pass no onLimit, so they
    // simply cap-and-summarize without prompting anyone.
    if (i >= limit) {
      let more = 0;
      if (typeof onLimit === 'function') { try { more = Number(await onLimit({ iterations: i })) || 0; } catch { more = 0; } }
      if (more > 0) { limit += more; } else { break; }
    }
    // User hit STOP: end the loop without another model call. Work done so
    // far (tool trace, streamed text) is preserved; the caller persists it.
    if (stopped()) { emit({ type: 'done' }); return { reply: '', toolTrace, iterations: i, usage, aborted: true }; }
    // In-loop ledger: tool results accrete INSIDE the loop (up to 24k chars
    // each), so the context defense has to run here too, not only between
    // turns. The hook is threshold-gated (maybeCompress) — cheap when under.
    if (typeof compact === 'function') { try { history = await compact(history); } catch {} }
    i++;
    emit({ type: 'model', model });
    let res;
    try {
      res = await chat({ model, messages: history, tools, onDelta: (d) => emit({ type: 'token', text: d.text }) });
    } catch (e) {
      // The abort signal kills the in-flight HTTP call — surface that as a
      // clean stop, not an error.
      if (stopped()) { emit({ type: 'done' }); return { reply: '', toolTrace, iterations: i, usage, aborted: true }; }
      throw e;
    }
    addUsage(res.usage);
    noteTruncation(res);
    const calls = res.toolCalls || [];

    if (calls.length === 0) {
      emit({ type: 'done' });
      return { reply: res.text || '', toolTrace, iterations: i, usage, truncated };
    }

    history.push({ role: 'assistant', content: res.text || '', toolCalls: calls, assistantRaw: res.assistantRaw });
    for (const call of calls) {
      if (stopped()) { emit({ type: 'done' }); return { reply: res.text || '', toolTrace, iterations: i, usage, aborted: true }; }
      emit({ type: 'tool-start', name: call.name });
      const t0 = Date.now();
      let out;
      try { out = await callTool(call.name, call.args); }
      catch (e) { out = { text: `ERROR: ${e.message}`, isError: true }; }
      const durationMs = Date.now() - t0;
      // Noise filter: strip low-signal bulk before the result re-enters context
      // (RTK-inspired). middle-elide is the backstop for anything still huge.
      const rawLen = (out.text || '').length;
      const filt = filterToolResult(call.name, out.text || '', { cap: 24000 });
      const content = filt.text;
      const truncated = filt.rules.includes('middle-elide');
      emit({ type: 'tool-end', name: call.name, ok: !out.isError, resultChars: rawLen, filteredChars: filt.after, rules: filt.rules, truncated, durationMs });
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
      toolTrace.push({ name: call.name, args: call.args, ok: !out.isError, resultChars: rawLen, filteredChars: filt.after, rules: filt.rules, truncated, durationMs });
    }
  }

  // Ran out of tool-call iterations without a final answer. Rather than leave the
  // user with a dangling preamble ("Let me investigate…" and nothing more), force
  // ONE last tool-less call so the model must write a conclusion from what it has
  // already gathered. This guarantees every turn ends with a real answer.
  emit({ type: 'model', model });
  let wrap;
  try {
    wrap = await chat({
      model,
      messages: [...history, { role: 'user', content: 'You have reached the tool-call limit — do NOT call any more tools. Using everything you have already gathered above, write your complete final answer now.' }],
      tools: [],
      onDelta: (d) => emit({ type: 'token', text: d.text })
    });
    addUsage(wrap.usage);
    noteTruncation(wrap);
  } catch (e) {
    // Deliberate degradation (a capped turn must still land), but never a
    // silent one — the glass box shows why the wrap-up came back empty.
    emit({ type: 'process', kind: 'wrapup-failed', error: (e && e.message) || 'model call failed' });
    wrap = { text: '' };
  }
  emit({ type: 'done' });
  return {
    reply: wrap.text || '(stopped after reaching the tool-call limit before a final answer could be produced)',
    toolTrace, iterations: i, usage, cappedTurn: true, truncated
  };
}

module.exports = { runChatLoop };
