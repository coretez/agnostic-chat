'use strict';

const { CODES, providerError } = require('./errors');

// Connector for the Anthropic (Claude) Messages API. Differs from OpenAI:
// auth via x-api-key + anthropic-version, system prompt is top-level (not a
// message), and max_tokens is required. Main-process only.

const ANTHROPIC_VERSION = '2023-06-01';

const { withRetry, httpError } = require('./retry');

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

// Chain an external abort signal (the user's STOP) onto a request's internal
// timeout controller, so a stop kills the in-flight HTTP call immediately.
function linkSignal(ctrl, signal) {
  if (!signal) return;
  if (signal.aborted) { ctrl.abort(); return; }
  signal.addEventListener('abort', () => ctrl.abort(), { once: true });
}

async function req(url, { key, method = 'GET', body, timeoutMs = 30000, signal }) {
  const ctrl = new AbortController();
  linkSignal(ctrl, signal);
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const detail = json?.error?.message || json?.message || (text ? text.slice(0, 400) : '');
      throw httpError(res.status, detail, res.headers.get('retry-after'));
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      // The cause is known HERE — carry it as a code, not a sentence.
      throw signal && signal.aborted
        ? providerError(CODES.USER_ABORT, 'stopped by user')
        : providerError(CODES.PROVIDER_TIMEOUT, `Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Neutral history → Anthropic turns. Tool results must ride in a user turn as
// tool_result blocks, so consecutive tool outputs are folded into one user msg.
function toAnthropicTurns(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content ?? '' });
    } else if (m.role === 'assistant') {
      if (m.assistantRaw) { out.push({ role: 'assistant', content: m.assistantRaw }); continue; }
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of (m.toolCalls || [])) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
      out.push({ role: 'assistant', content: blocks.length ? blocks : (m.content ?? '') });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

// Streaming (SSE) for the Messages API. Idle-timeout based — 300s, matching
// openai-compat: thinking models can reason silently before the first delta.
async function streamAnthropic(base, key, body, onDelta, signal, onRetry) {
  const ctrl = new AbortController();
  linkSignal(ctrl, signal);
  const IDLE = 300000;
  let idle = setTimeout(() => ctrl.abort(), IDLE);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE); };
  let res;
  try {
    // Connect phase is retryable — nothing has streamed yet.
    res = await withRetry(async () => {
      let r;
      try {
        r = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ ...body, stream: true }),
          signal: ctrl.signal
        });
      } catch (e) {
        if (e.name === 'AbortError') {
          throw signal && signal.aborted
            ? providerError(CODES.USER_ABORT, 'stopped by user')
            : providerError(CODES.STREAM_STALLED, 'stream stalled (no data)');
        }
        const err = new Error(`stream connect failed: ${e.message}`);
        err.retryable = true;
        throw err;
      }
      if (!r.ok) { const t = await r.text(); throw httpError(r.status, t.slice(0, 400), r.headers.get('retry-after')); }
      return r;
    }, { retries: 3, signal: ctrl.signal, onRetry });
  } catch (e) { clearTimeout(idle); throw e; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let usage = null;
  let stopReason = null;
  const blocks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        // A mid-stream error event means the response FAILED — dropping it
        // presented partial text as a complete answer.
        if (j.type === 'error') throw new Error(`stream error: ${(j.error && j.error.message) || JSON.stringify(j.error || {}).slice(0, 200)}`);
        if (j.type === 'message_start' && j.message && j.message.usage) usage = { ...j.message.usage };
        else if (j.type === 'message_delta') {
          if (j.usage) usage = { ...(usage || {}), ...j.usage };
          if (j.delta && j.delta.stop_reason) stopReason = j.delta.stop_reason;
        }
        if (j.type === 'content_block_start') { const b = j.content_block || {}; blocks[j.index] = { type: b.type, id: b.id, name: b.name, text: '', jsonbuf: '' }; }
        else if (j.type === 'content_block_delta') {
          const d = j.delta || {}; const b = blocks[j.index] || (blocks[j.index] = { type: 'text', text: '', jsonbuf: '' });
          if (d.type === 'text_delta') { b.text += d.text; text += d.text; onDelta({ text: d.text }); }
          else if (d.type === 'input_json_delta') { b.jsonbuf += d.partial_json; }
        }
      }
    }
  } finally { clearTimeout(idle); }

  const content = []; const toolCalls = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text') content.push({ type: 'text', text: b.text || '' });
    else if (b.type === 'tool_use') { let input = {}; try { input = JSON.parse(b.jsonbuf || '{}'); } catch {} content.push({ type: 'tool_use', id: b.id, name: b.name, input }); toolCalls.push({ id: b.id, name: b.name, args: input }); }
  }
  return { text, toolCalls, assistantRaw: content, usage: normalizeUsage(usage), finishReason: stopReason, truncated: stopReason === 'max_tokens' };
}

// Normalize an Anthropic usage object to our shape (best-effort; null if absent).
function normalizeUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cachedTokens: u.cache_read_input_tokens || 0,
    cacheCreationTokens: u.cache_creation_input_tokens || 0
  };
}

/**
 * @param {{baseUrl:string, key:string}} conn
 */
function anthropic({ baseUrl, key }) {
  const base = trimSlash(baseUrl);
  return {
    async listModels() {
      const json = await req(`${base}/v1/models`, { key, timeoutMs: 15000 });
      const data = Array.isArray(json?.data) ? json.data : [];
      return data.map((m) => m.id).filter(Boolean).sort();
    },
    async chat({ model, messages, tools, maxTokens, onDelta, forceTool, signal, onRetry }) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined;
      // 8192 default: every current Claude model supports it, and 4096 was
      // silently truncating long reports (now at least visible via truncated).
      const body = { model, max_tokens: maxTokens || 8192, system, messages: toAnthropicTurns(messages) };
      if (tools && tools.length) {
        body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: 'object' } }));
        // See openai-compat.js: force the single synthetic tool for a
        // structured-output call instead of leaving it to the model.
        if (forceTool && tools.length === 1) body.tool_choice = { type: 'tool', name: tools[0].name };
      }
      if (onDelta) return streamAnthropic(base, key, body, onDelta, signal, onRetry);
      const json = await withRetry(() => req(`${base}/v1/messages`, { key, method: 'POST', body, timeoutMs: 300000, signal }), { retries: 3, signal, onRetry });
      const content = Array.isArray(json?.content) ? json.content : [];
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
      return { text, toolCalls, assistantRaw: content, raw: json, usage: normalizeUsage(json.usage), finishReason: json.stop_reason || null, truncated: json.stop_reason === 'max_tokens' };
    }
  };
}

module.exports = { anthropic };
