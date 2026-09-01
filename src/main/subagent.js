'use strict';

// Sub-agent runtime — the core of the isolation strategy.
//
// A sub-agent runs a delegated task in its OWN thread: its own message list, its
// own context budget, its own compression. It does the heavy/messy work (reading
// a huge tool result, a multi-step search) and returns ONLY a distilled
// conclusion to the parent — so the main thread never ingests the raw bulk.
//
// One level deep by design: a sub-agent gets the MCP tools but NOT `delegate`,
// so it cannot spawn further sub-agents (keeps the tree shallow and legible).

const { runChatLoop } = require('./chat-loop');
const { maybeCompress, contextWindowFor, renderForSummary, SUMMARY_PROMPT, estimateTokens } = require('./compress');

// A focused evidence workflow commonly needs 6-8 ordered tool calls plus one
// final reasoning pass. Six iterations made those tasks structurally
// impossible to finish when the model issued one call per round (case
// investigations exposed this reliably). Keep the cap bounded, but leave
// enough room for the promised conclusion.
const SUBAGENT_MAX_ITERS = 10;

const DEFAULT_AGENT = {
  name: 'general',
  system_prompt:
    'You are a focused sub-agent working on ONE delegated task inside your own '
    + 'isolated context. Use the available tools as needed, then return ONLY a '
    + 'concise, self-contained conclusion — the findings or result the caller '
    + 'needs — not your working notes or raw tool output. Be specific and brief. '
    + 'When the caller requests an evidence bundle or inputs for a downstream '
    + 'report, preserve every material count, date/window, category breakdown, '
    + 'named finding, source status, and explicit data gap needed to draft and '
    + 'verify that report without repeating your tool calls. Compact does not '
    + 'mean incomplete. '
    + 'If your findings include concrete identifiers, paths, or parameter values '
    + 'the caller will need for follow-up work, end your conclusion with a fenced '
    + '```json block of flat key/value pairs (e.g. {"case_id": "…"}). Omit the '
    + 'block when there are none.'
};

function subagentCompactor(connector, model, fastModel) {
  return async (messages) => {
    const result = await maybeCompress({
      messages, contextWindow: contextWindowFor(model),
      summarize: async (older) => {
        const response = await connector.chat({ model: fastModel, messages: [{ role: 'user', content: SUMMARY_PROMPT + renderForSummary(older) }], maxTokens: 500 });
        return response.text || '';
      }
    });
    return result.messages;
  };
}

function forwardSubagentTools(emit, agentName) {
  return (event) => {
    if (!['tool-start', 'tool-end'].includes(event.type)) return;
    emit({ type: 'process', kind: `subagent-${event.type}`, agent: agentName, name: event.name, ok: event.ok, resultChars: event.resultChars, truncated: event.truncated });
  };
}

function subagentResult(result, startedAt) {
  const conclusion = (result.reply || '').trim();
  const conclusionTokens = estimateTokens([{ content: conclusion }]);
  const inputTokens = (result.toolTrace || []).reduce((total, trace) => total + Math.ceil((trace.resultChars || 0) / 4), 0);
  return { conclusion, conclusionTokens, inputTokens, toolTrace: result.toolTrace, iterations: result.iterations, durationMs: Date.now() - startedAt };
}

/**
 * Run a delegated task in an isolated sub-thread.
 * @param {object} o
 * @param {object} o.connector       provider connector ({chat})
 * @param {string} o.model           model for the sub-agent
 * @param {string} o.fastModel       cheap model for the sub-agent's own compression
 * @param {object} [o.agent]         {name, system_prompt} — defaults to DEFAULT_AGENT
 * @param {string} o.task            the delegated task (complete + standalone)
 * @param {Array}  o.tools           MCP tools available to the sub-agent (no `delegate`)
 * @param {function} o.callTool      async (name, args) => {text, isError} (MCP only)
 * @param {function} [o.onEvent]     receives {type:'process', kind, ...} events
 * @returns {Promise<{conclusion, conclusionTokens, inputTokens, toolTrace, iterations}>}
 */
async function runSubagent({ connector, model, fastModel, agent, task, tools = [], callTool, onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const selectedAgent = agent || DEFAULT_AGENT;
  const startedAt = Date.now();
  const started = { agent: selectedAgent.name, task };
  emit({ type: 'process', kind: 'subagent-start', ...started });
  const messages = [
    { role: 'system', content: selectedAgent.system_prompt || DEFAULT_AGENT.system_prompt },
    { role: 'user', content: task }
  ];
  const result = await runChatLoop({
    chat: (request) => connector.chat(request), callTool, model, messages, tools,
    maxIters: SUBAGENT_MAX_ITERS, compact: subagentCompactor(connector, model, fastModel),
    onEvent: forwardSubagentTools(emit, selectedAgent.name)
  });
  const summary = subagentResult(result, startedAt);
  emit({ type: 'process', kind: 'subagent-done', agent: selectedAgent.name, conclusionTokens: summary.conclusionTokens, inputTokens: summary.inputTokens, iterations: summary.iterations, tools: (summary.toolTrace || []).length, durationMs: summary.durationMs });
  return summary;
}

/**
 * Merge several sub-agent conclusions into one coherent result (the "merge" half
 * of assign-and-merge orchestration). A synthesis LLM call, not string glue.
 */
async function mergeResults({ connector, model, instruction, results, onEvent }) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  emit({ type: 'process', kind: 'merge-start', count: results.length });
  const body = results.map((r, i) => `## Result ${i + 1} — agent: ${r.agent}\nTask: ${r.task}\n\n${r.conclusion}`).join('\n\n---\n\n');
  const prompt =
    `You are merging the results of several sub-agents that each worked in isolation. `
    + `Combine them into a single coherent result.\n\nHow to merge: ${instruction || 'synthesize into one clear answer, resolving overlaps.'}\n\n`
    + `After the merged result, append a fenced \`\`\`json block of flat key/value pairs with every concrete identifier, path, or parameter value later steps will need (verbatim from the results). Omit the block if there are none.\n\n`
    + `SUB-AGENT RESULTS:\n\n${body}`;
  const r = await connector.chat({ model, messages: [{ role: 'user', content: prompt }], maxTokens: 4000 });
  const merged = (r.text || '').trim();
  emit({ type: 'process', kind: 'merge-done', tokens: Math.ceil(merged.length / 4) });
  return merged;
}

// The tool the ORCHESTRATOR (main thread) is given so the model can delegate.
const DELEGATE_TOOL = {
  name: 'delegate',
  description:
    'Delegate a self-contained sub-task to a sub-agent that works in its OWN '
    + 'isolated context window and returns only a distilled conclusion. Use this '
    + 'for heavy work — reading large tool outputs or files, multi-step research, '
    + 'anything that would bloat this conversation — to keep the main thread\'s '
    + 'context clean. This includes any evidence-gathering, assessment, or posture '
    + 'workflow that needs several sequential tool calls before you can answer '
    + '(e.g. compliance/security assessments, multi-source lookups): delegate the '
    + 'whole workflow up front rather than making those calls yourself and pulling '
    + 'each raw result into this thread — the sub-agent absorbs the raw evidence '
    + 'and hands back only the synthesized answer. This also covers explore-then-act '
    + 'patterns — e.g. listing available tables/schemas/fields before running the '
    + 'actual query, or browsing to find the right identifier before acting on it: '
    + 'delegate the whole "figure out what to query, then query it" task as one '
    + 'unit, so the intermediate schema/listing dump never lands in this thread. '
    + 'Give complete, standalone instructions; the sub-agent cannot see this '
    + 'conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Agent name to use, or "auto" for a general sub-agent.' },
      task: { type: 'string', description: 'Complete, self-contained instructions for the sub-agent.' }
    },
    required: ['task']
  }
};

// Assign several sub-tasks at once (parallel fan-out) and optionally merge them.
const ASSIGN_TOOL = {
  name: 'assign',
  description:
    'Assign several sub-tasks at once — each runs in parallel in its own isolated '
    + 'sub-agent context — then optionally MERGE their conclusions into one result. '
    + 'Use when work splits into independent parts (compare two periods, research '
    + 'several items, review multiple files): far faster than delegating one at a '
    + 'time, and the main thread only ever sees the merged/ distilled output.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'The sub-tasks to run in parallel.',
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'Agent name, or "auto" for a general sub-agent.' },
            task: { type: 'string', description: 'Complete, self-contained instructions.' }
          },
          required: ['task']
        }
      },
      merge: { type: 'string', description: 'Optional: how to combine the results into one. Omit to get them back separately.' }
    },
    required: ['tasks']
  }
};

module.exports = { runSubagent, mergeResults, DEFAULT_AGENT, DELEGATE_TOOL, ASSIGN_TOOL };
