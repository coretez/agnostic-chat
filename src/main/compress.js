'use strict';

// Conversation-history compression, à la Onyx (COMPRESSION_TRIGGER_RATIO = 0.75).
// When the neutral history nears the model's context window, summarize the older
// turns (via an injected `summarize` fn, typically the provider's fast model) and
// replace them with a single system "summary of earlier conversation", keeping
// the system prompt(s) and the most recent turns verbatim.

const COMPRESSION_TRIGGER_RATIO = 0.75;

// Rough token estimate (~4 chars/token) — good enough to decide when to compress.
function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content || '').length;
    for (const tc of (m.toolCalls || [])) chars += JSON.stringify(tc.args || {}).length + (tc.name || '').length;
  }
  return Math.ceil(chars / 4);
}

// Approximate context windows by model family. Conservative — compressing a bit
// early is fine; overflowing is not. Falls back to 128k.
function contextWindowFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('gemini')) return 1000000;
  if (m.includes('gpt-5') || m.includes('gpt-4.1')) return 400000;
  if (m.includes('gpt-4o') || m.includes('o4') || m.includes('o3')) return 128000;
  if (m.includes('claude')) return 200000;
  if (m.includes('qwen')) return 131072;
  if (m.includes('kimi') || m.includes('moonshot')) return 250000; // k2.x ≈ 262k; stay just under
  if (m.includes('llama')) return 131072;
  return 128000;
}

function renderForSummary(messages) {
  return messages.map((m) => {
    const who = m.role.toUpperCase();
    const tools = (m.toolCalls || []).map((t) => `[calls ${t.name}]`).join(' ');
    return `${who}: ${m.content || ''}${tools ? ' ' + tools : ''}`;
  }).join('\n');
}

/**
 * @param {object} o
 * @param {Array}  o.messages neutral history
 * @param {number} o.contextWindow tokens
 * @param {function} o.summarize async (olderMessages) => string
 * @param {number} [o.ratio=0.75]
 * @param {number} [o.keepRecent=6] recent non-system messages kept verbatim
 * @param {string} [o.protect] content that must SURVIVE compaction verbatim
 *   (the variable store's KNOWN VALUES digest — discovered tool parameters
 *   must never be summarized away; see the internal planning-architecture record §5/P3).
 *   Re-injected as its own system message right after the summary.
 * @returns {Promise<{messages:Array, compressed:boolean, tokensBefore:number}>}
 */
async function maybeCompress({ messages, contextWindow, summarize, ratio = COMPRESSION_TRIGGER_RATIO, keepRecent = 6, protect }) {
  const tokensBefore = estimateTokens(messages);
  const budget = contextWindow * ratio;
  if (tokensBefore <= budget) return { messages, compressed: false, tokensBefore };

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length <= keepRecent) return { messages, compressed: false, tokensBefore };

  // The kept window must start on a USER message. A cut that lands on a tool
  // message orphans it from its summarized-away assistant tool_use parent
  // (invalid history — providers 400 on it, exactly when context is largest),
  // and Anthropic requires the first turn to be user-role anyway. keepRecent
  // is therefore a minimum, not an exact count.
  let cut = rest.length - keepRecent;
  while (cut > 0 && rest[cut].role !== 'user') cut--;
  if (cut <= 0) return { messages, compressed: false, tokensBefore };

  const older = rest.slice(0, cut);
  const recent = rest.slice(cut);
  const summary = await summarize(older);
  const summaryMsg = { role: 'system', content: `Summary of earlier conversation (older turns were compressed to save context):\n${summary}` };
  const protectMsg = protect ? [{ role: 'system', content: protect }] : [];
  return { messages: [...system, summaryMsg, ...protectMsg, ...recent], compressed: true, tokensBefore };
}

const SUMMARY_PROMPT =
  'Summarize the following conversation concisely. Preserve decisions made, concrete facts, file/identifier names, and any open questions or next steps. Use short bullet points.\n\n';

module.exports = { maybeCompress, estimateTokens, contextWindowFor, renderForSummary, SUMMARY_PROMPT, COMPRESSION_TRIGGER_RATIO };
