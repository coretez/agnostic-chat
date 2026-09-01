'use strict';

const http = require('node:http');

function json(url) {
  return new Promise((resolve, reject) => http.get(url, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject));
}

async function evaluate(expression) {
  const targets = await json(process.env.SHAMROCK_CDP_URL || 'http://127.0.0.1:9222/json/list');
  const target = targets.find((item) => item.type === 'page' && item.title === 'Shamrock');
  if (!target) throw new Error('The running Shamrock window was not found.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const result = await new Promise((resolve, reject) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    };
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  socket.close();
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed');
  return result.result.value;
}

function requiredRunId(value) {
  const runId = Number(value);
  if (!Number.isInteger(runId) || runId < 1) throw new Error('A workflow run id is required.');
  return runId;
}

async function abortCommand(turnId) {
  if (!/^live-[a-z]+-[a-z0-9]+$/.test(turnId || '')) throw new Error('A valid live benchmark turn id is required.');
  await evaluate(`window.api.abortChat(${JSON.stringify(turnId)}); 'abort-requested'`);
  console.log(`Abort requested for ${turnId}`);
}

async function authStatusCommand() {
  console.log(JSON.stringify(await evaluate('window.api.mcp.authStatus()'), null, 2));
}

async function workflowCommand(value) {
  const runId = requiredRunId(value);
  console.log(JSON.stringify(await evaluate(`window.api.workflows.get(${runId})`), null, 2));
}

async function workflowStatusCommand(value) {
  const runId = requiredRunId(value);
  const expression = `(async () => { const run = await window.api.workflows.get(${runId}); return run && ({ id: run.id, status: run.status, currentStep: run.current_step, error: run.error, checkpoints: run.checkpoints.map((row) => ({ step: row.step_key, incomplete: !!(row.result && row.result.incomplete), conclusionChars: String((row.result && row.result.conclusion) || '').length, tools: (row.toolTrace || []).map((tool) => tool.name) })) }); })()`;
  console.log(JSON.stringify(await evaluate(expression), null, 2));
}

function resumeExpression(runId) {
  return `(async () => {
      const run = await window.api.workflows.get(${runId});
      if (!run) throw new Error('workflow not found');
      const provider = (await window.api.providers.list()).find((row) => row.enabled);
      if (!provider) throw new Error('no enabled provider');
      const model = provider.default_model || (provider.models && provider.models[0]);
      const prompt = 'Continue the interrupted workflow from its durable checkpoint. Reuse completed evidence and do not replay completed work.';
      const turnId = 'live-resume-' + Date.now().toString(36);
      const events = [];
      const unsub = window.api.onChatProgress((event) => {
        if (event.turnId && event.turnId !== turnId) return;
        if (event.type === 'action-approve') window.api.continueChat(1, turnId);
        if (event.type === 'limit' || event.type === 'stuck') window.api.continueChat(0, turnId);
        if (event.type === 'process') events.push({ kind: event.kind, step: event.step, completed: event.completed, partial: event.partial, remaining: event.remaining, blocked: event.blocked, status: event.status, failures: event.failures });
      });
      const started = Date.now();
      try {
        await window.api.messages.add({ chatId: run.chat_id, role: 'user', content: prompt });
        const result = await window.api.sendMessage({ providerId: provider.id, model, messages: [{ role: 'user', content: prompt }], text: prompt, projectId: run.project_id, chatId: run.chat_id, turnId, resumeRunId: run.id });
        await window.api.messages.add({ chatId: run.chat_id, role: 'assistant', content: result.reply || '', metadata: { model: result.model, tools: result.toolTrace || [], acceptance: result.acceptance || null } });
        return { runId: run.id, chatId: run.chat_id, durationMs: Date.now() - started, reply: result.reply, acceptance: result.acceptance, tools: result.toolTrace || [], events };
      } finally { unsub(); }
    })()`;
}

async function resumeCommand(value) {
  const expression = resumeExpression(requiredRunId(value));
  console.log(JSON.stringify(await evaluate(expression), null, 2));
}

const COMMANDS = { abort: abortCommand, 'auth-status': authStatusCommand, workflow: workflowCommand, 'workflow-status': workflowStatusCommand, resume: resumeCommand };

async function main() {
  const command = process.argv[2];
  const handler = COMMANDS[command];
  if (!handler) throw new Error('Choose: abort <turn-id> | auth-status | workflow <run-id> | workflow-status <run-id> | resume <run-id>');
  await handler(process.argv[3]);
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
