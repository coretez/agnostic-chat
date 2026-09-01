'use strict';

// Bound the provider-facing cost of long research loops without breaking the
// assistant-tool message protocol. Raw sizes and calls remain in toolTrace;
// older prompt results retain deterministic evidence slices and source URLs.

const DEFAULT_KEEP_ROUNDS = 2;
const DEFAULT_OLD_RESULT_CAP = 3200;
const MARKER = '[Earlier tool result compacted by Shamrock';

function sourceUrls(text, limit = 8) {
  return [...new Set(String(text || '').match(/https?:\/\/[^\s<>)\]"']+/g) || [])].slice(0, limit);
}

function compactContent(content, cap) {
  const text = String(content || '');
  if (text.length <= cap || text.startsWith(MARKER)) return text;
  const urls = sourceUrls(text);
  const urlBlock = urls.length ? `\nSource URLs retained:\n${urls.join('\n')}` : '';
  const room = Math.max(400, cap - urlBlock.length - 180);
  const head = Math.ceil(room / 2);
  const tail = Math.floor(room / 2);
  return `${MARKER}: ${text.length} original chars]\n${text.slice(0, head)}\n… ${text.length - head - tail} chars omitted …\n${text.slice(-tail)}${urlBlock}`;
}

function recentToolIds(messages, keepRounds) {
  const rounds = messages.filter((m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length);
  const recent = rounds.slice(-keepRounds);
  return new Set(recent.flatMap((m) => m.toolCalls.map((call) => call.id).filter(Boolean)));
}

function compactMessage(message, recentIds, cap) {
  if (message.role !== 'tool' || recentIds.has(message.toolCallId)) return { message, inspected: message.role === 'tool' ? 1 : 0, compacted: 0, saved: 0 };
  const content = compactContent(message.content, cap);
  const saved = Math.max(0, String(message.content || '').length - content.length);
  return { message: saved ? { ...message, content } : message, inspected: 1, compacted: saved ? 1 : 0, saved };
}

function compactToolHistory(messages, options = {}) {
  const keepRounds = Math.max(1, Number(options.keepRecentRounds) || DEFAULT_KEEP_ROUNDS);
  const cap = Math.max(800, Number(options.maxOldResultChars) || DEFAULT_OLD_RESULT_CAP);
  const recentIds = recentToolIds(messages, keepRounds);
  const rows = messages.map((message) => compactMessage(message, recentIds, cap));
  return {
    messages: rows.map((row) => row.message),
    stats: {
      inspected: rows.reduce((n, row) => n + row.inspected, 0),
      compacted: rows.reduce((n, row) => n + row.compacted, 0),
      savedChars: rows.reduce((n, row) => n + row.saved, 0),
      keptRecentRounds: keepRounds
    }
  };
}

module.exports = { compactToolHistory, compactContent, sourceUrls, DEFAULT_KEEP_ROUNDS, DEFAULT_OLD_RESULT_CAP };
