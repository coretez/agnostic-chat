'use strict';

const { CODES, providerError } = require('./errors');

// Connector for the Anthropic (Claude) Messages API. Differs from OpenAI:
// auth via x-api-key + anthropic-version, system prompt is top-level (not a
// message), and max_tokens is required. Main-process only.

const ANTHROPIC_VERSION = '2023-06-01';

const { withRetry } = require('./retry');
const { requestJson, createStreamDeadline, connectStream } = require('./http-transport');
const STREAM_TOTAL_TIMEOUT_MS = 180000;
const CHAT_REQUEST_RETRIES = 0;

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

// Chain an external abort signal (the user's STOP) onto a request's internal
// timeout controller, so a stop kills the in-flight HTTP call immediately.
async function req(url, { key, method = 'GET', body, timeoutMs = 30000, signal }) {
  return requestJson(url, {
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json' },
    method, body, timeoutMs, signal
  });
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

// Streaming (SSE) for the Messages API. Idle detection tolerates long initial
// reasoning, while the total deadline keeps a workflow checkpoint finite.
function processAnthropicEvent(state, event, onDelta) {
  if (event.type === 'error') throw new Error(`stream error: ${event.error?.message || JSON.stringify(event.error || {}).slice(0, 200)}`);
  if (event.type === 'message_start' && event.message?.usage) state.usage = { ...event.message.usage };
  if (event.type === 'message_delta') {
    if (event.usage) state.usage = { ...(state.usage || {}), ...event.usage };
    if (event.delta?.stop_reason) state.stopReason = event.delta.stop_reason;
  }
  if (event.type === 'content_block_start') {
    const block = event.content_block || {};
    state.blocks[event.index] = { type: block.type, id: block.id, name: block.name, text: '', jsonbuf: '' };
  }
  if (event.type === 'content_block_delta') processAnthropicBlockDelta(state, event, onDelta);
}

function processAnthropicBlockDelta(state, event, onDelta) {
  const delta = event.delta || {};
  const block = state.blocks[event.index] || (state.blocks[event.index] = { type: 'text', text: '', jsonbuf: '' });
  if (delta.type === 'text_delta') {
    block.text += delta.text;
    state.text += delta.text;
    onDelta({ text: delta.text });
  } else if (delta.type === 'input_json_delta') block.jsonbuf += delta.partial_json;
}

function processAnthropicLines(state, onDelta) {
  let newlineIndex;
  while ((newlineIndex = state.buffer.indexOf('\n')) >= 0) {
    const line = state.buffer.slice(0, newlineIndex).trim();
    state.buffer = state.buffer.slice(newlineIndex + 1);
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try { processAnthropicEvent(state, JSON.parse(data), onDelta); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
}

async function readAnthropicStream(response, onDelta, deadline) {
  const state = { buffer: '', text: '', usage: null, stopReason: null, blocks: [] };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    deadline.bump();
    state.buffer += decoder.decode(value, { stream: true });
    processAnthropicLines(state, onDelta);
  }
  return state;
}

function anthropicStreamResult(state) {
  const content = [];
  const toolCalls = [];
  let malformedToolCalls = 0;
  for (const b of state.blocks) {
    if (!b) continue;
    if (b.type === 'text') content.push({ type: 'text', text: b.text || '' });
    else if (b.type === 'tool_use') {
      let input; let valid = true;
      try { input = JSON.parse(b.jsonbuf || '{}'); }
      catch { malformedToolCalls += 1; valid = false; input = {}; }
      content.push({ type: 'tool_use', id: b.id, name: b.name, input });
      if (valid) toolCalls.push({ id: b.id, name: b.name, args: input });
    }
  }
  const truncated = state.stopReason === 'max_tokens';
  return { text: state.text, toolCalls: truncated ? [] : toolCalls, assistantRaw: content, usage: normalizeUsage(state.usage), finishReason: state.stopReason, truncated, malformedToolCalls, discardedToolCalls: truncated ? toolCalls.length + malformedToolCalls : malformedToolCalls };
}

async function streamAnthropic(base, key, body, onDelta, signal, onRetry, timeoutMs = STREAM_TOTAL_TIMEOUT_MS) {
  const deadline = createStreamDeadline(signal, timeoutMs);
  try {
    const response = await connectStream({
      url: `${base}/v1/messages`,
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: { ...body, stream: true }, signal, onRetry, deadline
    });
    return anthropicStreamResult(await readAnthropicStream(response, onDelta, deadline));
  } catch (error) {
    if (error?.name === 'AbortError') throw signal?.aborted ? providerError(CODES.USER_ABORT, 'stopped by user') : deadline.timeoutError();
    throw error;
  } finally { deadline.clear(); }
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
      const { json } = await req(`${base}/v1/models`, { key, timeoutMs: 15000 });
      const data = Array.isArray(json?.data) ? json.data : [];
      return data.map((m) => m.id).filter(Boolean).sort();
    },
    async chat({ model, messages, tools, maxTokens, onDelta, forceTool, signal, onRetry, timeoutMs = STREAM_TOTAL_TIMEOUT_MS }) {
      timeoutMs = Math.max(30000, Math.min(600000, Number(timeoutMs) || STREAM_TOTAL_TIMEOUT_MS));
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
      if (onDelta) return streamAnthropic(base, key, body, onDelta, signal, onRetry, timeoutMs);
      const { json, responseMeta } = await withRetry(() => req(`${base}/v1/messages`, { key, method: 'POST', body, timeoutMs, signal }), { retries: CHAT_REQUEST_RETRIES, signal, onRetry });
      const blockedText = responseMeta.blocked ? (json?.error?.message || responseMeta.message || 'Blocked by the LLM guard') : '';
      const content = Array.isArray(json?.content) ? json.content : (blockedText ? [{ type: 'text', text: blockedText }] : []);
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const parsedToolCalls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
      const truncated = json.stop_reason === 'max_tokens';
      return { text, toolCalls: truncated ? [] : parsedToolCalls, assistantRaw: content, raw: json, usage: normalizeUsage(json.usage), finishReason: responseMeta.blocked ? 'content_filter' : (json.stop_reason || null), truncated, discardedToolCalls: truncated ? parsedToolCalls.length : 0, guardMeta: responseMeta };
    }
  };
}

module.exports = { anthropic, STREAM_TOTAL_TIMEOUT_MS, CHAT_REQUEST_RETRIES };
