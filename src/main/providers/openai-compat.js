'use strict';

// Connector for OpenAI-compatible APIs (OpenAI, Qwen/DashScope, Kimi/Moonshot,
// Gemini's OpenAI-compat endpoint). All speak /chat/completions and /models with
// a Bearer key. Runs in the MAIN process only — the key never reaches the renderer.

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
        Authorization: `Bearer ${key}`,
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
      throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

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

// Streaming chat completion (SSE). Idle-timeout based — no total timeout, so a
// long generation never times out as long as tokens keep flowing.
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

async function streamChat(base, key, body, onDelta, signal) {
  const ctrl = new AbortController();
  linkSignal(ctrl, signal);
  // Idle = time with NO stream data. Thinking models (Kimi K2.x, o-series
  // style) can reason silently for minutes before the first delta — 90s
  // aborted healthy requests mid-think (seen live 2026-08-08: a monthly-
  // report turn died with "This operation was aborted"). A stalled stream
  // still dies, just patiently.
  const IDLE = 300000;
  let idle = setTimeout(() => ctrl.abort(), IDLE);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), IDLE); };
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) { clearTimeout(idle); throw new Error(e.name === 'AbortError' ? 'stream stalled (no data)' : `stream connect failed: ${e.message}`); }
  if (!res.ok) { clearTimeout(idle); const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t.slice(0, 400)}`); }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let usage = null;
  const byIndex = new Map();
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
        if (data === '[DONE]') { buf = ''; break; }
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = j.usage; // final chunk (include_usage) carries token counts
        const delta = j.choices?.[0]?.delta || {};
        if (delta.content) { text += delta.content; onDelta({ text: delta.content }); }
        for (const tc of (delta.tool_calls || [])) {
          const idx = tc.index ?? 0;
          let cur = byIndex.get(idx);
          if (!cur) { cur = { id: tc.id, type: tc.type || 'function', function: { name: '', arguments: '' } }; byIndex.set(idx, cur); }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name = tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          for (const k of Object.keys(tc)) if (!['index', 'id', 'type', 'function'].includes(k)) cur[k] = tc[k]; // preserve extras (e.g. gemini thought_signature)
        }
      }
    }
  } finally { clearTimeout(idle); }

  const tcArr = [...byIndex.values()];
  const assistantRaw = { role: 'assistant', content: text || null };
  if (tcArr.length) assistantRaw.tool_calls = tcArr;
  const toolCalls = tcArr.map((tc) => ({ id: tc.id, name: tc.function?.name, args: safeJson(tc.function?.arguments) }));
  return { text, toolCalls, assistantRaw, usage: normalizeUsage(usage) };
}

/**
 * @param {{baseUrl:string, key:string}} conn
 */
function openaiCompat({ baseUrl, key }) {
  const base = trimSlash(baseUrl);
  return {
    async listModels() {
      const json = await req(`${base}/models`, { key, timeoutMs: 15000 });
      const data = Array.isArray(json?.data) ? json.data : [];
      return data.map((m) => m.id).filter(Boolean).filter(isLikelyChatModel).sort();
    },
    async chat({ model, messages, tools, maxTokens, onDelta, forceTool, signal }) {
      const body = { model, messages: messages.map(toOpenAiMsg), stream: !!onDelta };
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
        const json = await req(`${base}/chat/completions`, { key, method: 'POST', body, timeoutMs: 300000, signal });
        const msg = json?.choices?.[0]?.message || {};
        const toolCalls = (msg.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function?.name, args: safeJson(tc.function?.arguments) }));
        return { text: msg.content || '', toolCalls, assistantRaw: msg, raw: json, usage: normalizeUsage(json.usage) };
      }
      return streamChat(base, key, body, onDelta, signal);
    }
  };
}

module.exports = { openaiCompat };
