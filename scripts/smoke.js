'use strict';

// Headless smoke test of the data layer. Runs inside Electron's main process
// (so node:sqlite + safeStorage are available). Uses a throwaway temp DB.

const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { openDatabase } = require('../src/main/db');
const repo = require('../src/main/db/repo');
const secrets = require('../src/main/secrets');
const { registryList, getConnector } = require('../src/main/providers');
const { connectAndList, McpConnection } = require('../src/main/mcp/client');
const mcpManager = require('../src/main/mcp/manager');
const { runChatLoop } = require('../src/main/chat-loop');
const { maybeCompress } = require('../src/main/compress');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok -', msg);
}

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-smoke-'));
  openDatabase(path.join(tmp, 'test.db'));

  console.log('safeStorage available:', secrets.isAvailable());

  // Projects
  const projA = repo.projects.create({ name: 'Client Onboarding', description: 'docs + process' });
  const projB = repo.projects.create({ name: 'Security Research' });
  assert(projA.slug === 'client-onboarding', 'project slug generated');
  assert(repo.projects.list().length === 2, 'two projects listed');

  // Chats + messages
  const chat = repo.chats.create({ projectId: projA.id, title: 'Kickoff', model: 'claude-opus-4-8' });
  repo.messages.add({ chatId: chat.id, role: 'user', content: 'Draft the onboarding doc' });
  repo.messages.add({ chatId: chat.id, role: 'assistant', content: 'Here is a draft…' });
  assert(repo.messages.listByChat(chat.id).length === 2, 'two messages in chat');

  // Documents live on the PROJECT; chats just link to them
  const doc = repo.documents.create({
    projectId: projA.id, title: 'Onboarding Checklist', content: '# Checklist', source: 'chat'
  });
  repo.documents.linkToChat({ chatId: chat.id, documentId: doc.id, relation: 'created' });
  assert(repo.documents.listByProject(projA.id).length === 1, 'doc listed under project');
  assert(repo.documents.listByChat(chat.id)[0].relation === 'created', 'doc linked to chat as created');
  // Cross-project isolation
  assert(repo.documents.listByProject(projB.id).length === 0, 'projB sees none of projA docs');

  // Skills — opt-out per project (ON by default; disable to exclude)
  const skillDocs = repo.skills.create({ name: 'docx', description: 'Word docs' });
  const skillSec = repo.skills.create({ name: 'security-review', description: 'security' });
  assert(repo.skills.listEnabledForProject(projA.id).length === 2, 'skills are ON by default for a project');
  assert(repo.skills.isEnabled(projA.id, skillDocs.id) === true, 'skill enabled by default when no row exists');
  repo.skills.setForProject({ projectId: projA.id, skillId: skillSec.id, enabled: false });
  const aSkills = repo.skills.listEnabledForProject(projA.id);
  assert(aSkills.length === 1 && aSkills[0].name === 'docx', 'disabling a skill removes it for that project only');
  assert(repo.skills.listEnabledForProject(projB.id).length === 2, 'other project still sees all skills (disable is per-project)');
  assert(repo.skills.isEnabled(projA.id, skillSec.id) === false, 'explicitly disabled skill reports disabled');

  // Credentials: encrypt → store → list (no secret) → reveal round trip
  const cred = repo.credentials.set({
    projectId: projA.id, provider: 'anthropic', label: 'work key', secret: 'sk-ant-SECRET-123'
  });
  const listed = repo.credentials.list({ projectId: projA.id });
  assert(!('secret_ciphertext' in listed[0]) && !('secret' in listed[0]), 'list() exposes no secret material');
  assert(repo.credentials.reveal(cred.id) === 'sk-ant-SECRET-123', 'reveal() round-trips plaintext');

  // Providers: registry, encrypted key round trip, no-secret listing, connector dispatch
  const reg = registryList();
  const types = reg.map((r) => r.type);
  assert(['openai', 'anthropic', 'qwen', 'kimi', 'gemini'].every((t) => types.includes(t)), 'registry has all 5 provider types');

  const prov = repo.providers.add({ type: 'openai', label: 'Work', baseUrl: 'https://api.openai.com/v1', secret: 'sk-SECRET-xyz', defaultModel: 'gpt-4o' });
  const plist = repo.providers.list();
  assert(!('secret_ciphertext' in plist[0]) && !('secret' in plist[0]), 'providers.list() exposes no secret material');
  assert(repo.providers.reveal(prov.id) === 'sk-SECRET-xyz', 'providers.reveal() round-trips the key');
  repo.providers.update(prov.id, { enabled: false, models: ['gpt-4o', 'o4-mini'] });
  const updated = repo.providers.get(prov.id);
  assert(updated.enabled === false && updated.models.length === 2, 'providers.update() patches enabled + models');

  const oc = getConnector({ type: 'qwen' }, 'k');
  const an = getConnector({ type: 'anthropic' }, 'k');
  assert(typeof oc.chat === 'function' && typeof oc.listModels === 'function', 'openai-compat connector built for qwen');
  assert(typeof an.chat === 'function' && typeof an.listModels === 'function', 'anthropic connector built');

  // MCP: repo (encrypted env, no-secret listing) + live stdio connect to fake server
  const srv = repo.mcp.add({ name: 'Fake', transport: 'stdio', command: 'node', args: [path.join(__dirname, 'fake-mcp-server.js')], secret: { env: { TOKEN: 'xyz' } } });
  const mlist = repo.mcp.list();
  assert(!('secret_ciphertext' in mlist[0]) && mlist[0].has_secret === true, 'mcp.list() hides secret but reports has_secret');
  assert(repo.mcp.reveal(srv.id).env.TOKEN === 'xyz', 'mcp.reveal() round-trips encrypted env');

  const conn = await connectAndList({ transport: 'stdio', command: 'node', args: [path.join(__dirname, 'fake-mcp-server.js')] });
  assert(conn.ok === true, 'stdio MCP client connected (initialize + tools/list)');
  assert(conn.tools.length === 3 && conn.tools.some((t) => t.name === 'search_docs'), 'stdio MCP client listed 3 tools');
  assert(conn.tools[0].inputSchema && conn.tools[0].inputSchema.type === 'object', 'tools include inputSchema');

  // Manager: register a fake server, build the toolset (namespaced), call a tool for real
  const fake = repo.mcp.add({ name: 'fake srv', transport: 'stdio', command: 'node', args: [path.join(__dirname, 'fake-mcp-server.js')], enabled: true });
  const ts = await mcpManager.buildToolset();
  const echoName = ts.tools.find((t) => t.name === 'fake_srv__echo')?.name;
  assert(!!echoName, 'buildToolset namespaced tools by server (fake_srv__echo present)');
  assert(ts.tools.every((t) => t.inputSchema), 'toolset tools carry inputSchema for the model');
  const called = await mcpManager.callTool(echoName, { text: 'hi' }, ts.routes);
  assert(called.text === 'echo: hi', 'manager.callTool executed the tool over a live connection');
  mcpManager.disposeAll();

  // Chat loop: fake connector requests a tool, then answers using the result
  let step = 0;
  const fakeChat = async ({ messages }) => {
    if (step++ === 0) return { text: '', toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'hi' } }] };
    return { text: `final: ${messages[messages.length - 1].content}`, toolCalls: [] };
  };
  const loop = await runChatLoop({ chat: fakeChat, callTool: async (n, a) => ({ text: `echo: ${a.text}`, isError: false }), model: 'm', messages: [{ role: 'user', content: 'q' }], tools: [] });
  assert(loop.toolTrace.length === 1 && loop.toolTrace[0].name === 'echo', 'chat loop recorded one tool call');
  assert(loop.reply === 'final: echo: hi', 'chat loop fed tool result back and produced final answer');

  // Sub-agent runtime: delegate → runs its own loop (with a tool) → returns a conclusion
  const { runSubagent } = require('../src/main/subagent');
  let sstep = 0;
  const subConnector = { chat: async ({ messages }) => {
    if (sstep++ === 0) return { text: '', toolCalls: [{ id: 's1', name: 'read', args: { path: 'big.json' } }] };
    return { text: 'CONCLUSION: 3 findings', toolCalls: [] };
  } };
  const procEvents = [];
  const sub = await runSubagent({
    connector: subConnector, model: 'm', fastModel: 'm', task: 'read big.json and distill',
    tools: [{ name: 'read' }],
    callTool: async () => ({ text: 'x'.repeat(80000), isError: false }),
    onEvent: (ev) => procEvents.push(ev)
  });
  assert(sub.conclusion === 'CONCLUSION: 3 findings', 'sub-agent returns a distilled conclusion');
  assert(sub.inputTokens > 15000 && sub.conclusionTokens < 50, 'sub-agent absorbs bulk, returns little (isolation win)');
  assert(procEvents.some((e) => e.kind === 'subagent-start') && procEvents.some((e) => e.kind === 'subagent-done'), 'sub-agent emits process lifecycle events');

  // Meta-evaluator: parses findings from a model reply (even wrapped in prose/fences)
  const { runEvaluator, extractJson } = require('../src/main/evaluator');
  assert(extractJson('here you go: {"a":{"b":1}} thanks').trim() === '{"a":{"b":1}}', 'evaluator extracts balanced JSON from noisy text');
  const evalConnector = { chat: async () => ({ text: '```json\n{"assessment":"tool-heavy turn","findings":[{"category":"delegation","severity":"high","observation":"74k report dumped inline","suggestion":"delegate the pull","target":"usage"}]}\n```' }) };
  const evalRes = await runEvaluator({ connector: evalConnector, model: 'm', digest: { totalTokens: 99000 } });
  assert(evalRes.findings.length === 1 && evalRes.findings[0].target === 'usage', 'evaluator returns parsed findings');
  assert(evalRes.assessment === 'tool-heavy turn', 'evaluator returns an assessment');

  // Skill selection: only the chosen skill's full definition is loaded
  const { selectSkills } = require('../src/main/skill-select');
  const selConnector = { chat: async () => ({ text: 'sure: {"skills":["docx"]}' }) };
  const selRes = await selectSkills({ connector: selConnector, model: 'm', skills: [
    { name: 'docx', description: 'make Word docs', definition: 'X'.repeat(9000) },
    { name: 'security-review', description: 'audit code', definition: 'Y'.repeat(9000) }
  ], userText: 'write me a word document' });
  assert(selRes.names.length === 1 && selRes.names[0] === 'docx', 'skill selector picks only the relevant skill');
  const selNone = await selectSkills({ connector: { chat: async () => ({ text: '{"skills":[]}' }) }, model: 'm', skills: [{ name: 'docx', description: 'd' }], userText: 'hi' });
  assert(selNone.names.length === 0, 'skill selector can pick none');

  // Orchestration: assign work in PARALLEL + merge the results (the full round-trip)
  const { runSubagent: rsa, mergeResults } = require('../src/main/subagent');
  const proc = [];
  let active = 0, maxActive = 0;
  const orchConn = { chat: async ({ messages }) => {
    const u = (messages.find((m) => m.role === 'user') || {}).content || '';
    if (u.startsWith('You are merging')) return { text: 'MERGED(' + (u.match(/## Result \d+/g) || []).length + ')' };
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 25));
    active--;
    return { text: 'C:' + u.slice(0, 10), toolCalls: [] };
  } };
  const assignments = [{ task: 'compare the last 14 days' }, { task: 'compare the previous 14 days' }];
  const results = await Promise.all(assignments.map(async (t) => {
    const r = await rsa({ connector: orchConn, model: 'm', fastModel: 'm', task: t.task, tools: [], callTool: async () => ({ text: 'x' }), onEvent: (e) => proc.push(e) });
    return { agent: 'general', task: t.task, conclusion: r.conclusion };
  }));
  assert(results.length === 2 && results.every((r) => r.conclusion.startsWith('C:')), 'assign ran both sub-tasks and each returned a conclusion');
  assert(maxActive === 2, 'assigned sub-agents ran in PARALLEL (both active at once)');
  const merged = await mergeResults({ connector: orchConn, model: 'm', instruction: 'combine both periods', results, onEvent: (e) => proc.push(e) });
  assert(merged === 'MERGED(2)', 'merge synthesized both results into one');
  assert(proc.filter((e) => e.kind === 'subagent-done').length === 2, 'both sub-agents emitted done events');
  assert(proc.some((e) => e.kind === 'merge-start') && proc.some((e) => e.kind === 'merge-done'), 'merge emits lifecycle events for the PROCESS view');

  // Noise filter: strips low-signal bulk from tool results (RTK-inspired)
  const { filterToolResult } = require('../src/main/filter');
  const pretty = JSON.stringify({ report: 'x'.repeat(80), rows: Array(150).fill({ sev: 'high', host: 'h' }) }, null, 2);
  const f1 = filterToolResult('run_report', pretty);
  assert(f1.after < f1.before * 0.5 && f1.rules.includes('json-min'), 'filter minifies pretty JSON (big saving)');
  const f2 = filterToolResult('logs', Array.from({ length: 20000 }, (_, i) => `event ${i} occurred at host-${i % 7}`).join('\n'), { cap: 2000 });
  assert(f2.after <= 2500 && f2.rules.includes('middle-elide'), 'filter middle-elides huge output to the cap');
  const f2b = filterToolResult('logs', 'repeated warning\n'.repeat(5000));
  assert(f2b.after < 200 && f2b.rules.includes('dedup-lines'), 'filter collapses runs of duplicate lines');
  const f3 = filterToolResult('noop', 'a short clean result');
  assert(f3.after === f3.before && f3.rules.length === 0, 'filter leaves small clean output untouched');
  // Chat loop applies the filter to tool results
  let cstep = 0;
  const bigJson = JSON.stringify({ items: Array(400).fill({ a: 1, b: 2 }) }, null, 2);
  const floop = await runChatLoop({
    chat: async () => (cstep++ === 0 ? { text: '', toolCalls: [{ id: 'x', name: 'q', args: {} }] } : { text: 'done', toolCalls: [] }),
    callTool: async () => ({ text: bigJson, isError: false }),
    model: 'm', messages: [{ role: 'user', content: 'q' }], tools: []
  });
  assert(floop.toolTrace[0].filteredChars < floop.toolTrace[0].resultChars, 'chat loop filters tool results before feeding them back');

  // Telemetry: chat loop aggregates real provider usage across calls
  let ustep = 0;
  const uloop = await runChatLoop({
    chat: async () => (ustep++ === 0
      ? { text: '', toolCalls: [{ id: 'u', name: 'q', args: {} }], usage: { inputTokens: 1000, outputTokens: 50, cachedTokens: 800 } }
      : { text: 'ok', toolCalls: [], usage: { inputTokens: 1200, outputTokens: 30, cachedTokens: 1100 } }),
    callTool: async () => ({ text: 'r', isError: false }),
    model: 'm', messages: [{ role: 'user', content: 'q' }], tools: []
  });
  assert(uloop.usage.measured && uloop.usage.inputTokens === 2200 && uloop.usage.cachedTokens === 1900, 'chat loop aggregates provider token usage across iterations');

  // turn_metrics persists and reads back
  const mid = repo.metrics.record({ projectId: projA.id, chatId: chat.id, model: 'm', measured: true, inputTokens: 2200, outputTokens: 80, cachedTokens: 1900, estInputTokens: 2400, window: 250000, skillsAvailable: 33, skillsLoaded: 2, skillSavedTokens: 218000, skillsUsed: ['a', 'b'], filterSavedTokens: 68000, compactionSavedTokens: 0, delegated: 2, delegateAbsorbedTokens: 140000 });
  assert(mid > 0, 'turn_metrics row recorded');
  const mrows = repo.metrics.listByChat(chat.id);
  assert(mrows.length >= 1 && mrows[mrows.length - 1].cached_tokens === 1900 && mrows[mrows.length - 1].measured === 1, 'turn_metrics reads back real usage');

  // Authored agents: per-project CRUD + name/tool resolution
  const ag = repo.agents.create({ projectId: projA.id, name: 'report-reader', description: 'pulls + distills reports', systemPrompt: 'Read the report and return 3 findings.', tools: ['fluency__run_report'] });
  assert(ag.id && Array.isArray(ag.tools) && ag.tools[0] === 'fluency__run_report', 'agent created with tool allowlist parsed');
  assert(repo.agents.listByProject(projA.id).some((a) => a.name === 'report-reader'), 'agent listed under its project');
  assert(repo.agents.getByName(projA.id, 'REPORT-READER') && repo.agents.getByName(projA.id, 'REPORT-READER').id === ag.id, 'agent lookup by name is case-insensitive');
  assert(repo.agents.listByProject(projB.id).length === 0, 'agents are scoped to their project');
  const ag2 = repo.agents.update(ag.id, { model: 'kimi-k2.6', tools: null });
  assert(ag2.model === 'kimi-k2.6' && ag2.tools === null, 'agent update patches model + clears tool allowlist');
  repo.agents.remove(ag.id);
  assert(repo.agents.listByProject(projA.id).length === 0, 'agent removed');

  // Compression bundle
  const providerFast = repo.providers.add({ type: 'openai', label: 'F', secret: 'k', defaultModel: 'gpt-4o', fastModel: 'gpt-4o-mini' });
  assert(repo.providers.get(providerFast.id).fast_model === 'gpt-4o-mini', 'provider stores fast_model');
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(4000) });
  const comp = await maybeCompress({ messages: many, contextWindow: 1000, summarize: async () => 'SUMMARY', keepRecent: 4 });
  assert(comp.compressed === true && comp.messages.some((m) => m.content.includes('SUMMARY')), 'compression summarizes older turns when over budget');
  assert(comp.messages.length < many.length, 'compression reduces the message count');
  const small = await maybeCompress({ messages: [{ role: 'user', content: 'hi' }], contextWindow: 100000, summarize: async () => 'S' });
  assert(small.compressed === false, 'compression is skipped when under budget');

  // Chat management (rename + soft-delete)
  const cmProj = repo.projects.create({ name: 'ChatMgmt' });
  const cmChat = repo.chats.create({ projectId: cmProj.id, title: 'A' });
  repo.chats.rename(cmChat.id, 'Renamed');
  assert(repo.chats.listByProject(cmProj.id)[0].title === 'Renamed', 'chat rename persists');
  repo.chats.archive(cmChat.id);
  assert(repo.chats.listByProject(cmProj.id).length === 0, 'archived chat is hidden from the list');

  // MCP resources foundation (for widgets)
  const rc = new McpConnection({ transport: 'stdio', command: 'node', args: [path.join(__dirname, 'fake-mcp-server.js')] });
  await rc.openConnection();
  const resources = await rc.listResources();
  assert(resources.length >= 1 && resources[0].uri.startsWith('ui://'), 'MCP resources/list returns a ui:// resource');
  const contents = await rc.readResource(resources[0].uri);
  assert(contents[0] && contents[0].text.includes('<h1>'), 'MCP resources/read returns resource contents');
  rc.close();

  console.log('\nALL SMOKE TESTS PASSED');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
}).catch((err) => {
  console.error('\nSMOKE TEST ERROR:', err);
  app.exit(1);
});
