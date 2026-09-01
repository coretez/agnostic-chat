'use strict';

const { CODES, providerError } = require('./errors');

// Connector for OpenAI-compatible APIs (OpenAI, Qwen/DashScope, Kimi/Moonshot,
// Gemini's OpenAI-compat endpoint). All speak /chat/completions and /models with
// a Bearer key. Runs in the MAIN process only — the key never reaches the renderer.

const { withRetry } = require('./retry');
const { requestJson, guardMetadata, createStreamDeadline, connectStream } = require('./http-transport');
const STREAM_TOTAL_TIMEOUT_MS = 180000;
const CHAT_REQUEST_RETRIES = 0;

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

// Chain an external abort signal (the user's STOP) onto a request's internal
// timeout controller, so a stop kills the in-flight HTTP call immediately.
async function req(url, { key, method = 'GET', body, timeoutMs = 30000, signal }) {
  return requestJson(url, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    method, body, timeoutMs, signal
  });
}

function parseToolArgs(s) {
  try { return { ok: true, args: JSON.parse(s || '{}') }; }
  catch { return { ok: false, args: null }; }
}

// Normalize an MCP tool's JSON Schema for provider function-calling. Gemini's
// OpenAI-compatible endpoint (and strict OpenAI) reject several JSON-Schema
// keywords; strip them and guarantee an object shape with `properties`.
const SCHEMA_STRIP = ['$schema', '$id', '$ref', '$defs', 'definitions', 'additionalProperties', 'title', 'default', 'examples', 'patternProperties', 'const'];
function sanitizeSchema(s) {
  if (!s || typeof s !== 'object') return { type: 'object', properties: {} };
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (SCHEMA_STRIP.includes(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = sanitizeSchema(pv);
    } else if (k === 'items') {
      out.items = sanitizeSchema(v);
    } else if (['anyOf', 'oneOf', 'allOf'].includes(k) && Array.isArray(v)) {
      out[k] = v.map(sanitizeSchema);
    } else {
      out[k] = v;
    }
  }
  if ((out.type === 'object' || out.properties) && !out.properties) out.properties = {};
  if (!out.type && out.properties) out.type = 'object';
  return out;
}

// OpenAI's /models lists many non-chat models (embeddings, audio, image, legacy
// base models). Drop those so the picker only offers usable chat models.
const NON_CHAT = ['embedding', 'whisper', 'tts', 'audio', 'dall-e', 'dalle', 'image', 'moderation', 'babbage', 'davinci', 'ada', 'curie', 'transcribe', 'realtime', 'search', 'rerank', 'guard'];
function isLikelyChatModel(id) {
  const m = String(id).toLowerCase();
  if (NON_CHAT.some((d) => m.includes(d))) return false;
  if (/\d{4}-\d{2}-\d{2}/.test(m)) return false;   // dated snapshot e.g. -2024-08-06
  if (/-\d{3,4}$/.test(m)) return false;            // dated alias e.g. -0125, -0613
  return true;
}

// Neutral history → OpenAI chat message.
function toOpenAiMsg(m) {
  // Replay the provider's own assistant message verbatim so provider-specific
  // fields (e.g. Gemini's required thought_signature on tool calls) survive.
  if (m.role === 'assistant' && m.assistantRaw) return m.assistantRaw;
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }))
    };
  }
  return { role: m.role, content: m.content ?? '' };
}

// Streaming chat completion (SSE). Both idle and wall-clock deadlines apply:
// keepalive/reasoning traffic must not hold a workflow checkpoint forever.
// Normalize an OpenAI-style usage object to our shape (best-effort; null if absent).
function normalizeUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    cachedTokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
    cacheCreationTokens: 0
  };
}

function mergeOpenAiToolDelta(state, toolDelta) {
  const index = toolDelta.index ?? 0;
  let toolCall = state.toolCallsByIndex.get(index);
  if (!toolCall) {
    toolCall = { id: toolDelta.id, type: toolDelta.type || 'function', function: { name: '', arguments: '' } };
    state.toolCallsByIndex.set(index, toolCall);
  }
  if (toolDelta.id) toolCall.id = toolDelta.id;
  if (toolDelta.function?.name) toolCall.function.name = toolDelta.function.name;
  if (toolDelta.function?.arguments) toolCall.function.arguments += toolDelta.function.arguments;
  for (const key of Object.keys(toolDelta)) {
    if (!['index', 'id', 'type', 'function'].includes(key)) toolCall[key] = toolDelta[key];
  }
}

function processOpenAiEvent(state, event, onDelta) {
  if (event.error) throw new Error(`stream error: ${event.error.message || JSON.stringify(event.error).slice(0, 200)}`);
  if (event.usage) state.usage = event.usage;
  const choice = event.choices?.[0] || {};
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  const delta = choice.delta || {};
  if (delta.content) {
    state.text += delta.content;
    onDelta({ text: delta.content });
  }
  for (const toolDelta of delta.tool_calls || []) mergeOpenAiToolDelta(state, toolDelta);
}

function processOpenAiLines(state, onDelta) {
  let newlineIndex;
  while ((newlineIndex = state.buffer.indexOf('\n')) >= 0) {
    const line = state.buffer.slice(0, newlineIndex).trim();
    state.buffer = state.buffer.slice(newlineIndex + 1);
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { state.buffer = ''; break; }
    try { processOpenAiEvent(state, JSON.parse(data), onDelta); } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
}

async function readOpenAiStream(response, onDelta, deadline) {
  const state = { buffer: '', text: '', usage: null, finishReason: null, toolCallsByIndex: new Map() };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    deadline.bump();
    state.buffer += decoder.decode(value, { stream: true });
    processOpenAiLines(state, onDelta);
  }
  return state;
}

function openAiStreamResult(state, response) {
  const toolCallMessages = [...state.toolCallsByIndex.values()];
  const assistantRaw = { role: 'assistant', content: state.text || null };
  if (toolCallMessages.length) assistantRaw.tool_calls = toolCallMessages;
  const parsedToolCalls = toolCallMessages.map((toolCall) => ({ toolCall, parsed: parseToolArgs(toolCall.function?.arguments) }));
  // A length-capped response is not a committed function call. Its JSON may
  // be cut mid-string (the common case) or happen to close just before other
  // required output was truncated. Never route either form to a mutating tool.
  const malformedCount = parsedToolCalls.filter((entry) => !entry.parsed.ok).length;
  const toolCalls = state.finishReason === 'length' ? [] : parsedToolCalls
    .filter((entry) => entry.parsed.ok)
    .map(({ toolCall, parsed }) => ({ id: toolCall.id, name: toolCall.function?.name, args: parsed.args }));
  return {
    text: state.text, toolCalls, assistantRaw, usage: normalizeUsage(state.usage), finishReason: state.finishReason,
    truncated: state.finishReason === 'length', malformedToolCalls: malformedCount,
    discardedToolCalls: state.finishReason === 'length' ? toolCallMessages.length : malformedCount,
    guardMeta: guardMetadata(response)
  };
}

async function streamChat(base, key, body, onDelta, signal, onRetry, timeoutMs = STREAM_TOTAL_TIMEOUT_MS) {
  const deadline = createStreamDeadline(signal, timeoutMs);
  try {
    const response = await connectStream({
      url: `${base}/chat/completions`,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body, signal, onRetry, deadline
    });
    const state = await readOpenAiStream(response, onDelta, deadline);
    return openAiStreamResult(state, response);
  } catch (error) {
    if (error?.name === 'AbortError') throw signal?.aborted ? providerError(CODES.USER_ABORT, 'stopped by user') : deadline.timeoutError();
    throw error;
  } finally { deadline.clear(); }
}

/**
 * @param {{baseUrl:string, key:string}} conn
 */
function openaiCompat({ baseUrl, key }) {
  const base = trimSlash(baseUrl);
  return {
    async listModels() {
      const { json } = await req(`${base}/models`, { key, timeoutMs: 15000 });
      const data = Array.isArray(json?.data) ? json.data : [];
      return data.map((m) => m.id).filter(Boolean).filter(isLikelyChatModel).sort();
    },
    async chat({ model, messages, tools, maxTokens, onDelta, forceTool, signal, onRetry, timeoutMs = STREAM_TOTAL_TIMEOUT_MS }) {
      timeoutMs = Math.max(30000, Math.min(600000, Number(timeoutMs) || STREAM_TOTAL_TIMEOUT_MS));
      const outboundMessages = messages.map(toOpenAiMsg).filter((message) =>
        !(message.role === 'assistant' && !message.content && !(message.tool_calls && message.tool_calls.length)));
      const body = { model, messages: outboundMessages, stream: !!onDelta };
      if (onDelta) body.stream_options = { include_usage: true }; // ask for a final usage chunk
      if (maxTokens) body.max_tokens = maxTokens;
      if (tools && tools.length) {
        body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: sanitizeSchema(t.inputSchema) } }));
        // forceTool: for a single synthetic tool used purely as a structured-
        // output contract (e.g. the context planner), force the call instead
        // of leaving it to the model's discretion — the provider's own
        // function-calling layer then guarantees syntactically valid
        // arguments, instead of hoping a prose completion ends in clean JSON.
        body.tool_choice = (forceTool && tools.length === 1) ? { type: 'function', function: { name: tools[0].name } } : 'auto';
      }
      if (!onDelta) {
        // Non-streaming path (used for test pings + compression summaries).
        const { json, responseMeta } = await withRetry(() => req(`${base}/chat/completions`, { key, method: 'POST', body, timeoutMs, signal }), { retries: CHAT_REQUEST_RETRIES, signal, onRetry });
        const choice = json?.choices?.[0] || {};
        const msg = choice.message || {};
        const parsedToolCalls = (msg.tool_calls || []).map((tc) => ({ tc, parsed: parseToolArgs(tc.function?.arguments) }));
        const truncated = choice.finish_reason === 'length';
        const toolCalls = truncated ? [] : parsedToolCalls.filter((entry) => entry.parsed.ok)
          .map(({ tc, parsed }) => ({ id: tc.id, name: tc.function?.name, args: parsed.args }));
        return { text: msg.content || '', toolCalls, assistantRaw: msg, raw: json, usage: normalizeUsage(json.usage), finishReason: choice.finish_reason || null, truncated, malformedToolCalls: parsedToolCalls.filter((entry) => !entry.parsed.ok).length, discardedToolCalls: truncated ? parsedToolCalls.length : parsedToolCalls.filter((entry) => !entry.parsed.ok).length, guardMeta: responseMeta };
      }
      return streamChat(base, key, body, onDelta, signal, onRetry, timeoutMs);
    }
  };
}

module.exports = { openaiCompat, STREAM_TOTAL_TIMEOUT_MS, CHAT_REQUEST_RETRIES };
