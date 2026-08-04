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

  // Generated-document placement + write + versioning + index
  const { placementPath, writeDocument, resolveOutputDir } = require('../src/main/documents');
  assert(
    placementPath('documents/{type}/{tenant}/{title}-{period}.{ext}', { type: 'monthly-report', title: 'Expo Review', properties: { tenant: 'expo', period: '2026-08' }, format: 'html' }) === 'documents/monthly-report/expo/expo-review-2026-08.html',
    'placement template fills type/tenant/title/period/ext'
  );
  assert(
    placementPath('documents/{type}/{tenant}/{title}-{period}.{ext}', { type: 'note', title: 'Quick', format: 'md' }) === 'documents/note/quick.md',
    'placement drops empty tenant/period segments cleanly'
  );
  assert(resolveOutputDir({ name: 'Foo' }, '/base') === path.join('/base', 'Foo') && resolveOutputDir({ output_dir: '/x' }, '/base') === '/x', 'resolveOutputDir: explicit output_dir else <base>/<name>');
  const odir = fs.mkdtempSync(path.join(os.tmpdir(), 'agnostic-docs-'));
  const w1 = writeDocument({ outputDir: odir, template: 'documents/{type}/{title}.{ext}', meta: { type: 'report', title: 'R', format: 'txt' }, content: 'v1' });
  assert(fs.existsSync(w1.absPath) && w1.version === 1 && fs.readFileSync(w1.absPath, 'utf8') === 'v1', 'writeDocument writes the file (v1)');
  const w2 = writeDocument({ outputDir: odir, template: 'documents/{type}/{title}.{ext}', meta: { type: 'report', title: 'R', format: 'txt' }, content: 'v2' });
  assert(w2.version === 2 && fs.readFileSync(w2.absPath, 'utf8') === 'v2' && fs.existsSync(path.join(path.dirname(w2.absPath), '.versions', 'R.v1.txt')), 'writeDocument versions on resave (prior → .versions/)');
  const genRow = repo.documents.saveGenerated({ projectId: projA.id, title: 'R', path: w2.absPath, mimeType: 'text/plain', source: 'chat', docType: 'report', version: 2, properties: { tenant: 'expo' } });
  assert(genRow.doc_type === 'report' && genRow.version === 2 && genRow.properties.tenant === 'expo', 'saveGenerated indexes doc with type + properties');
  const again = repo.documents.saveGenerated({ projectId: projA.id, title: 'R', path: w2.absPath, version: 3 });
  assert(repo.documents.listByProject(projA.id).filter((d) => d.path === w2.absPath).length === 1 && again.version === 3, 'saveGenerated re-versions same path (no duplicate index rows)');
  repo.projects.setOutputDir(projA.id, '/tmp/custom-out');
  assert(repo.projects.get(projA.id).output_dir === '/tmp/custom-out', 'project output_dir is user-configurable');

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

  // A workflow that never stops calling tools must still END with a real answer:
  // on hitting the iteration cap, force one tool-less wrap-up call.
  let wstep = 0;
  const alwaysTool = async ({ tools }) => (!tools || !tools.length)
    ? { text: 'FINAL SUMMARY', toolCalls: [] }             // the forced wrap-up call
    : { text: 'working', toolCalls: [{ id: 'w' + (wstep++), name: 'echo', args: {} }] };
  const capped = await runChatLoop({ chat: alwaysTool, callTool: async () => ({ text: 'r', isError: false }), model: 'm', messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'echo' }], maxIters: 3 });
  assert(capped.cappedTurn === true && capped.reply === 'FINAL SUMMARY', 'chat loop forces a final answer when the tool-call limit is hit (no dangling preamble)');

  // Interactive continuation: onLimit can grant a fresh budget; when it declines, wrap up.
  let asks = 0;
  const onLimit = async () => (asks++ === 0 ? 5 : 0); // grant +5 the first time, stop the second
  const extended = await runChatLoop({
    chat: async ({ tools }) => (!tools || !tools.length) ? { text: 'WRAP', toolCalls: [] } : { text: '', toolCalls: [{ id: 't', name: 'echo', args: {} }] },
    callTool: async () => ({ text: 'r', isError: false }), model: 'm', messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'echo' }], maxIters: 2, onLimit
  });
  assert(asks === 2 && extended.iterations === 7 && extended.cappedTurn && extended.reply === 'WRAP', 'chat loop asks to continue, extends the budget (2+5), then wraps up when declined');

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

  // Context planning: ONE call decides both which skills and which tools to load
  const { selectContext, applyToolCeiling, truncateForMenu } = require('../src/main/context-select');
  // Regression: a 160-char hard cut on a real skill description sliced off its
  // "when to use" sentence one word before the match keyword, silently making
  // the skill unselectable for the exact requests it was written to trigger on.
  const caseInvestigationDesc = 'Produce the standard Fluency single-case investigation report as print-ready HTML and PDF. Use when the user names a Fluency case id, behavior key plus day, or asks to investigate, analyze, triage, write up, or decide whether a specific Fluency case is real or benign. The report follows the bundled case-investigation output contract.';
  const menuLine = truncateForMenu(caseInvestigationDesc, 300, 100);
  assert(menuLine.includes('asks to investigate'), 'skill menu truncation keeps the full trigger sentence instead of cutting mid-clause');
  assert(menuLine.endsWith('.'), 'skill menu truncation cuts at a sentence boundary, not an arbitrary character count');
  assert(truncateForMenu('short one.', 300, 100) === 'short one.', 'skill menu truncation leaves short descriptions untouched');
  const longRunOn = 'x'.repeat(500); // no sentence boundary at all — must still bound the worst case
  assert(truncateForMenu(longRunOn, 300, 100).length <= 301, 'skill menu truncation still hard-bounds a description with no sentence boundary');
  // End-to-end: the actual prompt built for the planner call must carry the
  // FULL skill description, not a truncated prefix — the skill editor's own
  // contract for this field is "one line — when to use it", authored
  // specifically as the trigger signal this call decides on; there is no
  // routine reason to cut it.
  const longSkillDesc = caseInvestigationDesc + ' Read-only on Fluency; the final verdict is handed back via record_case_investigation.';
  let capturedPrompt = '';
  await selectContext({ connector: { chat: async ({ messages }) => { capturedPrompt = messages[0].content; return { text: '{"skills":[],"tools":[]}' }; } }, model: 'm', skills: [{ name: 'fluency-case-investigation', description: longSkillDesc }], tools: [], userText: 'investigate riley.chen@acmeinc.com' });
  assert(capturedPrompt.includes('record_case_investigation'), 'the actual planner prompt carries the full skill description end-to-end, not just a truncated prefix');
  // Primary path: forced tool-calling. This is what actually fixed the
  // repeated production "context selector JSON parse failed" — a provider
  // that honors tool_choice returns structured toolCalls, not prose to parse.
  let capturedForceTool, capturedToolsArg;
  const ctxToolCallConnector = { chat: async ({ tools, forceTool }) => {
    capturedForceTool = forceTool; capturedToolsArg = tools;
    return { toolCalls: [{ id: 't1', name: 'select_context', args: { skills: ['docx'], tools: ['srv__tool_5'] } }] };
  } };
  const ctxToolCallRes = await selectContext({ connector: ctxToolCallConnector, model: 'm', skills: [{ name: 'docx', description: 'make Word docs' }], tools: [{ name: 'srv__tool_5', description: 'x' }], userText: 'write a doc' });
  assert(capturedForceTool === true && capturedToolsArg.length === 1 && capturedToolsArg[0].name === 'select_context', 'context planner forces a single synthetic tool call instead of prompting for freeform JSON');
  assert(ctxToolCallRes.skillNames.length === 1 && ctxToolCallRes.skillNames[0] === 'docx' && ctxToolCallRes.toolNames[0] === 'srv__tool_5', 'context planner reads structured tool-call arguments directly, no JSON extraction needed');
  // Regression: some thinking/reasoning providers reject a FORCED tool_choice
  // outright (HTTP 400 "tool_choice 'specified' is incompatible with thinking
  // enabled") — must retry with the tool merely offered, not force the whole
  // call to fail and fall through to "0 skills, full tool catalog".
  let retryAttempt = 0;
  const ctxRetryConnector = { chat: async ({ forceTool }) => {
    retryAttempt++;
    if (forceTool) throw new Error("HTTP 400: tool_choice 'specified' is incompatible with thinking enabled");
    return { toolCalls: [{ id: 't2', name: 'select_context', args: { skills: ['docx'], tools: [] } }] };
  } };
  const ctxRetryRes = await selectContext({ connector: ctxRetryConnector, model: 'm', skills: [{ name: 'docx', description: 'd' }], tools: [], userText: 'hi' });
  assert(retryAttempt === 2 && ctxRetryRes.skillNames.length === 1 && !ctxRetryRes.error, 'context planner retries without forcing tool_choice when the provider rejects a forced call outright');
  const ctxDoubleFailRes = await selectContext({ connector: { chat: async () => { throw new Error('network down'); } }, model: 'm', skills: [{ name: 'docx', description: 'd' }], tools: [], userText: 'hi' });
  assert(ctxDoubleFailRes.error && ctxDoubleFailRes.error.includes('network down'), 'context planner surfaces a clear error when both the forced and retry attempts fail');
  let ctxCalls = 0;
  const ctxConnector = { chat: async () => { ctxCalls++; return { text: 'sure: {"skills":["docx"],"tools":["srv__tool_3","srv__tool_9"]}' }; } };
  const bigCatalog = Array.from({ length: 34 }, (_, i) => ({ name: `srv__tool_${i}`, description: `does thing ${i}` }));
  const ctxRes = await selectContext({ connector: ctxConnector, model: 'm', skills: [
    { name: 'docx', description: 'make Word docs', definition: 'X'.repeat(9000) },
    { name: 'security-review', description: 'audit code', definition: 'Y'.repeat(9000) }
  ], tools: bigCatalog, userText: 'write me a word document and do thing 3 and 9' });
  assert(ctxCalls === 1, 'context planner makes exactly one call for both skills and tools');
  assert(ctxRes.skillNames.length === 1 && ctxRes.skillNames[0] === 'docx', 'context planner picks only the relevant skill');
  assert(ctxRes.toolNames.length === 2 && ctxRes.toolNames.includes('srv__tool_3'), 'context planner narrows the tool catalog to chosen tools');
  const ctxNone = await selectContext({ connector: { chat: async () => ({ text: '{"skills":[],"tools":[]}' }) }, model: 'm', skills: [{ name: 'docx', description: 'd' }], tools: [], userText: 'hi' });
  assert(ctxNone.skillNames.length === 0 && !ctxNone.skillMismatch, 'context planner can pick no skills, with no mismatch flagged for a genuinely empty pick');
  const ctxSkip = await selectContext({ connector: { chat: async () => { throw new Error('should not be called'); } }, model: 'm', skills: [], tools: [], userText: 'hi' });
  assert(ctxSkip.skillNames.length === 0 && ctxSkip.toolNames.length === 0, 'context planner skips the call entirely when nothing to plan');
  // A "successful" call that names something matching NOTHING we know (typo,
  // paraphrase, wrong id) must be distinguishable from a deliberate empty pick —
  // both end up 0 loaded, but only one is a bug worth surfacing.
  const ctxMismatch = await selectContext({ connector: { chat: async () => ({ text: '{"skills":["Case Investigation Skill"],"tools":[]}' }) }, model: 'm', skills: [{ name: 'fluency-case-investigation', description: 'd' }], tools: [], userText: 'investigate riley.chen@acmeinc.com' });
  assert(ctxMismatch.skillNames.length === 0 && ctxMismatch.skillMismatch && ctxMismatch.skillMismatch.includes('Case Investigation Skill'), 'context planner flags a skill-name mismatch instead of silently looking like a deliberate empty pick');

  // Tool ceiling: a skill's declared tool scope is a hard restriction, not a hint
  const allTools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const withinCeiling = applyToolCeiling({ loadedSkills: [{ name: 'reporting', tools: ['a', 'b'] }], toolNames: ['a'], allTools });
  assert(withinCeiling.tools.length === 1 && withinCeiling.tools[0].name === 'a' && withinCeiling.bySkills[0] === 'reporting' && !withinCeiling.fellBack, 'tool ceiling intersects the planner pick with the declared scope');
  const outsideCeiling = applyToolCeiling({ loadedSkills: [{ name: 'reporting', tools: ['a', 'b'] }], toolNames: ['c'], allTools });
  assert(outsideCeiling.tools.length === 2 && outsideCeiling.tools.every((t) => ['a', 'b'].includes(t.name)), 'tool ceiling falls back to the declared scope when the planner picks outside it');
  // No ceiling + nothing picked (planning failed) — default is the FULL catalog,
  // not an arbitrary slice: seen in production, a 32-of-205 slice happened to
  // omit every tool the turn actually needed. An explicit fallbackCap still works
  // for callers that want one, but it's no longer the default.
  const noCeilingNoPicksDefault = applyToolCeiling({ loadedSkills: [], toolNames: [], allTools: bigCatalog });
  assert(noCeilingNoPicksDefault.tools.length === bigCatalog.length && noCeilingNoPicksDefault.fellBack && !noCeilingNoPicksDefault.bySkills, 'tool ceiling defaults to the full catalog (not an arbitrary slice) when there is no scope and nothing picked');
  const noCeilingNoPicksCapped = applyToolCeiling({ loadedSkills: [], toolNames: [], allTools: bigCatalog, fallbackCap: 5 });
  assert(noCeilingNoPicksCapped.tools.length === 5 && noCeilingNoPicksCapped.fellBack, 'tool ceiling still honors an explicit fallbackCap when one is passed');

  // Planner: strategizes a request into steps + merge, then executes deterministically
  const { makePlan, runPlan } = require('../src/main/planner');
  const plan = await makePlan({ connector: { chat: async () => ({ text: '{"goal":"compare","steps":[{"task":"A","agent":"auto","parallel":true},{"task":"B","agent":"auto","parallel":true}],"merge":"compare A and B"}' }) }, model: 'm', request: 'compare A and B' });
  assert(plan.steps.length === 2 && plan.steps[0].parallel && plan.merge === 'compare A and B', 'planner produces a structured, parallel plan');
  const planConn = { chat: async ({ messages }) => { const u = (messages.find((m) => m.role === 'user') || {}).content || ''; return u.startsWith('You are merging') ? { text: 'MERGED' } : { text: 'C:' + u.slice(0, 6), toolCalls: [] }; } };
  const planRun = await runPlan({ plan, connector: planConn, model: 'm', fastModel: 'm', resolveAgent: () => ({ agent: { name: 'general', system_prompt: 'x' }, model: 'm', tools: [] }), callTool: async () => ({ text: 'r' }), onEvent: () => {} });
  assert(planRun.results.length === 2 && planRun.answer === 'MERGED', 'planner executes steps and AI-merges the results');

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
  // Planning-failure rate must be queryable across turns, not just visible
  // one turn at a time in the INTERNALS tab.
  repo.metrics.record({ projectId: projA.id, chatId: chat.id, model: 'm', planningFailed: true, toolFellBack: true });
  const mrows2 = repo.metrics.listByChat(chat.id);
  assert(mrows2[mrows2.length - 1].planning_failed === 1 && mrows2[mrows2.length - 1].tool_fell_back === 1, 'turn_metrics persists planning-failure and tool-fallback flags for cross-turn observability');

  // Task-level timing/tokens: chat loop times tool calls; sub-agents report duration
  assert(typeof floop.toolTrace[0].durationMs === 'number', 'chat loop records per-tool duration');
  const durSub = await runSubagent({ connector: { chat: async () => ({ text: 'C', toolCalls: [] }) }, model: 'm', fastModel: 'm', task: 'x', tools: [], callTool: async () => ({ text: 'r' }), onEvent: () => {} });
  assert(typeof durSub.durationMs === 'number', 'sub-agent reports its duration');
  repo.metrics.recordTasks([
    { projectId: projA.id, chatId: chat.id, kind: 'tool', label: 'fluency__run_report', tokens: 6000, durationMs: 1200, ok: true },
    { projectId: projA.id, chatId: chat.id, kind: 'subagent', label: 'report-reader', tokens: 74000, durationMs: 4300, ok: true }
  ]);
  const trows = repo.metrics.tasksByChat(chat.id);
  assert(trows.length === 2 && trows.some((t) => t.kind === 'tool' && t.duration_ms === 1200), 'task_metrics records per-task duration + tokens');
  const tsum = repo.metrics.taskSummary(projA.id);
  assert(tsum.some((s) => s.label === 'report-reader' && s.avg_ms === 4300), 'task summary aggregates avg duration per task');

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

  // ── P0: Variable store (working memory of discovered parameters) ───────────
  const { VariableStore, SET_VARIABLE_TOOL } = require('../src/main/variables');
  {
    const vs = new VariableStore();
    vs.set({ key: 'tenant_id', value: 'acme-prod' }, { step: 1, confidence: 'observed' });
    assert(vs.get('tenant_id') === 'acme-prod', 'variable store: set/get round-trip');

    // auto-capture from tool ARGS: id-like key kept, generic knobs ignored
    vs.captureFromArgs({ case_id: 'C-10432', limit: 50, query: 'foo' }, { step: 2, source: 'get_case' });
    assert(vs.get('case_id') === 'C-10432', 'captureFromArgs keeps id-like arg (case_id)');
    assert(!vs.has('limit') && !vs.has('query'), 'captureFromArgs ignores generic knobs (limit/query)');

    // auto-capture id-like fields from a JSON tool RESULT; skip noise
    vs.captureFromResult('list_cases', JSON.stringify({ cases: [{ case_id: 'C-10432', account_id: 'A-88', label: 'noise' }] }), { step: 2 });
    assert(vs.get('account_id') === 'A-88' && !vs.has('label'), 'captureFromResult harvests id-like fields, skips noise');

    // render → the KNOWN VALUES block injected into the prompt
    const block = vs.render();
    assert(block.startsWith('KNOWN VALUES') && block.includes('tenant_id = "acme-prod"'), 'render emits KNOWN VALUES block');

    // overwrite protection: an observed rediscovery must NOT clobber a user value
    vs.set({ key: 'region', value: 'us-east-1' }, { confidence: 'user', step: 1 });
    vs.set({ key: 'region', value: 'eu-west-9' }, { confidence: 'observed', step: 3 });
    assert(vs.get('region') === 'us-east-1', 'user-confidence value not clobbered by observed rediscovery');

    // explicit set_variable tool contract
    assert(SET_VARIABLE_TOOL.name === 'set_variable' && SET_VARIABLE_TOOL.inputSchema.required.includes('key'), 'set_variable tool schema requires a key');

    // deterministic order by turn-relative seq (re-observing a value doesn't reorder)
    const order = vs.list().map((e) => e.key);
    assert(order[0] === 'tenant_id' && order.indexOf('case_id') < order.indexOf('account_id'), 'entries ordered by capture sequence');
  }

  // P0 objective: a value captured in one step survives save→load and is read
  // back exactly by a later step (persisted via chats.variables_json).
  {
    const vChat = repo.chats.create({ projectId: projA.id, title: 'VarStore' });
    const step1 = new VariableStore();
    step1.captureFromArgs({ report_path: '/Users/chris/Documents/Agnostic Chat/report.md' }, { step: 1, source: 'save_document' });
    repo.chats.setVariables(vChat.id, JSON.stringify(step1.toJSON()));

    // …later step (or after an app restart): rebuild from the DB snapshot
    const step2 = VariableStore.fromJSON(repo.chats.getVariables(vChat.id));
    assert(step2.get('report_path') === '/Users/chris/Documents/Agnostic Chat/report.md', 'variable survives save→load round-trip');
    assert(step2.size === step1.size, 'store size preserved across persistence');

    // seq resumes past the persisted max so new captures don't collide
    step2.set({ key: 'follow_up_id', value: 'F-1' }, { step: 2 });
    const seqs = step2.list().map((e) => e.ts);
    assert(new Set(seqs).size === seqs.length, 'seq resumes monotonically after load (no ts collisions)');
  }

  // ── P1: Step executor (plan-and-execute, stuck → re-plan → escalate) ────────
  const { executeStep, executePlan } = require('../src/main/execute');
  {
    // (a) Objective: step 2's tool call is formed ONLY from a value step 1
    // discovered. Step 1's model lists tenants (result carries tenant_id); the
    // store captures it; step 2's directive shows it as a KNOWN VALUE and the
    // mock model reads it FROM THE DIRECTIVE (not from hardcoded knowledge).
    const store1 = new VariableStore();
    const calls = [];
    const mockChat = async ({ messages }) => {
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
      const directive = messages[lastUserIdx].content;
      // only tool results belonging to THIS step (after its directive) count
      const toolsThisStep = messages.slice(lastUserIdx + 1).some((m) => m.role === 'tool');
      if (/CURRENT STEP \(1\)/.test(directive)) {
        if (!toolsThisStep) return { text: '', toolCalls: [{ id: 't1', name: 'list_tenants', args: {} }] };
        return { text: 'Found the tenant.', toolCalls: [] };
      }
      // step 2: parse tenant_id out of the KNOWN VALUES block in the directive
      const m = directive.match(/tenant_id = "([^"]+)"/);
      if (m && !toolsThisStep) return { text: '', toolCalls: [{ id: 't2', name: 'get_tenant_report', args: { tenant_id: m[1] } }] };
      return { text: 'Report fetched.', toolCalls: [] };
    };
    const mockCallTool = async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_tenants') return { text: JSON.stringify({ tenants: [{ tenant_id: 'acme-prod' }] }) };
      return { text: 'ok' };
    };
    const s1 = await executeStep({ chat: mockChat, callTool: mockCallTool, model: 'mock', step: { id: 1, task: 'find the tenant' }, tools: [], history: [], store: store1 });
    assert(!s1.stuck && store1.get('tenant_id') === 'acme-prod', 'step 1 captured tenant_id from the tool result');
    const s2 = await executeStep({ chat: mockChat, callTool: mockCallTool, model: 'mock', step: { id: 2, task: 'pull the tenant report' }, tools: [], history: s1.history, store: store1 });
    const rep = calls.find((c) => c.name === 'get_tenant_report');
    assert(!s2.stuck && rep && rep.args.tenant_id === 'acme-prod', "step 2's tool call formed from step 1's discovered value");

    // set_variable is intercepted (never routed to MCP) and lands in the store
    const store2 = new VariableStore();
    const routed = [];
    const svChat = async ({ messages }) => {
      const lastTool = messages.filter((m) => m.role === 'tool').pop();
      if (!lastTool) return { text: '', toolCalls: [{ id: 'v1', name: 'set_variable', args: { key: 'case_id', value: 'C-7' } }] };
      return { text: 'done', toolCalls: [] };
    };
    await executeStep({ chat: svChat, callTool: async (n) => { routed.push(n); return { text: 'x' }; }, model: 'mock', step: { id: 1, task: 't' }, tools: [], history: [], store: store2 });
    assert(store2.get('case_id') === 'C-7' && routed.length === 0, 'set_variable intercepted into the store, not routed to MCP');
  }

  {
    // (b) Objective: a budget-exhausted step reports stuck with a forced partial
    // conclusion, triggers ≤3 auto re-plans, then escalates with an explanation.
    const looping = async ({ messages, tools }) => {
      if (!tools.length) return { text: 'partial: got half the data', toolCalls: [] };  // forced wrap-up
      return { text: '', toolCalls: [{ id: 'x', name: 'search', args: {} }] };          // never finishes
    };
    const noop = async () => ({ text: '{}' });

    const sStuck = await executeStep({ chat: looping, callTool: noop, model: 'mock', step: { id: 1, task: 'endless dig' }, tools: [{ name: 'search', description: '', inputSchema: {} }], history: [], store: new VariableStore(), budget: 2 });
    assert(sStuck.stuck && sStuck.reason === 'iteration-budget-exhausted', 'budget-exhausted step reports stuck');
    assert(sStuck.partial.includes('partial'), 'stuck step still forces a partial conclusion');

    // Orchestration: re-plan fires ≤3 times, then onStuck escalates with the
    // goal + what's stuck; user declines → partial kept for synthesis.
    let replanCalls = 0; let escalation = null;
    const out = await executePlan({
      chat: looping, callTool: noop, model: 'mock',
      plan: { goal: 'dig everything', steps: [{ id: 1, task: 'endless dig' }] },
      tools: [{ name: 'search', description: '', inputSchema: {} }],
      store: new VariableStore(), stepBudget: 1,
      refinePlan: async ({ stuckStep, reason }) => { replanCalls++; assert(reason === 'iteration-budget-exhausted', 'refinePlan told why the step stuck'); return { steps: [{ id: stuckStep.id, task: stuckStep.task }] }; },
      onStuck: async ({ goal, stuckStep, replans }) => { escalation = { goal, step: stuckStep.id, replans }; return { continue: false }; }
    });
    assert(replanCalls === 3, 'stuck step auto-re-planned exactly REPLAN_BUDGET (3) times');
    assert(escalation && escalation.goal === 'dig everything' && escalation.replans === 3, 'escalation carries the goal + re-plan count for the user');
    assert(out.stepResults.length === 1 && out.stepResults[0].incomplete, 'declined escalation keeps the partial for synthesis');

    // A useful re-plan (tail replaced with a completable step) needs no escalation.
    const healChat = async ({ messages, tools }) => {
      const directive = messages.filter((m) => m.role === 'user').pop().content;
      if (/fixed step/.test(directive)) return { text: 'completed via new approach', toolCalls: [] };
      if (!tools.length) return { text: 'partial', toolCalls: [] };
      return { text: '', toolCalls: [{ id: 'x', name: 'search', args: {} }] };
    };
    let escalated = false;
    const healed = await executePlan({
      chat: healChat, callTool: noop, model: 'mock',
      plan: { goal: 'g', steps: [{ id: 1, task: 'endless dig' }] },
      tools: [{ name: 'search', description: '', inputSchema: {} }],
      store: new VariableStore(), stepBudget: 1,
      refinePlan: async () => ({ steps: [{ id: 1, task: 'fixed step' }] }),
      onStuck: async () => { escalated = true; return { continue: false }; }
    });
    assert(healed.completed && !escalated && healed.replans === 1, 'successful re-plan completes the turn without escalating');
  }

  // ── P2: Plan derivation (Pass 2) — derivePlan / refinePlan ──────────────────
  const { derivePlan, refinePlan } = require('../src/main/plan-derive');
  {
    const mkConnector = (args) => ({ chat: async ({ tools }) => ({ text: '', toolCalls: [{ id: 'p', name: tools[0].name, args }] }) });
    const p1 = await derivePlan({
      connector: mkConnector({ simple: false, goal: 'monthly report', steps: [{ task: 'find the tenant id' }, { task: 'run the report', parallel: false }] }),
      model: 'mock', userText: 'make the monthly report', loadedSkills: [{ name: 'reporting', definition: 'steps: find tenant, run report' }], tools: [{ name: 'run_report' }], store: new VariableStore()
    });
    assert(!p1.simple && p1.steps.length === 2 && p1.steps[0].id === 1 && p1.steps[1].id === 2, 'derivePlan returns a well-formed ordered plan');

    const p2 = await derivePlan({ connector: mkConnector({ simple: true, goal: 'greet' }), model: 'mock', userText: 'hi', loadedSkills: [], tools: [{ name: 'x' }], store: new VariableStore() });
    assert(p2.simple, 'derivePlan trivial-turn gate: simple=true routes to the flat loop');

    const p3 = await derivePlan({ connector: mkConnector({ simple: false, goal: 'g', steps: [{ task: 'only one' }] }), model: 'mock', userText: 't', loadedSkills: [], tools: [], store: new VariableStore() });
    assert(p3.simple, 'derivePlan gate: a 1-step plan is treated as simple (nothing to orchestrate)');

    const pFail = await derivePlan({ connector: { chat: async () => { throw new Error('boom'); } }, model: 'mock', userText: 't', loadedSkills: [], tools: [], store: new VariableStore() });
    assert(pFail.simple && pFail.error, 'derivePlan failure degrades to simple (flat loop is the worst case)');

    const r1 = await refinePlan({
      connector: mkConnector({ simple: false, goal: 'g', steps: [{ task: 'alternative approach' }, { task: 'wrap up' }] }),
      model: 'mock', userText: 't', plan: { goal: 'g' }, done: [{ step: 1, task: 'a', conclusion: 'found X' }],
      stuckStep: { id: 2, task: 'blocked step' }, reason: 'iteration-budget-exhausted', store: new VariableStore()
    });
    assert(r1.steps.length === 2 && r1.steps[0].id === 2, 'refinePlan renumbers the revised tail from the stuck step');

    const rFail = await refinePlan({ connector: { chat: async () => { throw new Error('down'); } }, model: 'mock', plan: { goal: 'g' }, stuckStep: { id: 3, task: 'orig' }, reason: 'x', store: new VariableStore() });
    assert(rFail.steps.length === 1 && rFail.steps[0].task === 'orig', 'failed refine returns the stuck step (burns budget → escalation, never silently concludes)');
  }

  // ── P3: compaction protects the variable store digest ──────────────────────
  {
    const vs = new VariableStore();
    vs.set({ key: 'tenant_id', value: 'acme-prod' }, { step: 1 });
    const bulky = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(4000) }));
    const out = await maybeCompress({ messages: bulky, contextWindow: 10000, protect: vs.render(), summarize: async () => 'summary of older turns' });
    assert(out.compressed, 'protect fixture triggers compaction');
    const protectedMsg = out.messages.find((m) => m.role === 'system' && /KNOWN VALUES/.test(m.content));
    assert(protectedMsg && protectedMsg.content.includes('tenant_id = "acme-prod"'), 'KNOWN VALUES digest survives compaction verbatim (P3)');
    // P3 objective: the variable is still usable by a subsequent step.
    assert(vs.get('tenant_id') === 'acme-prod', 'store itself untouched by compaction');
  }

  // ── P5: parallel-step handoff + synthesis over mixed results ───────────────
  const { synthesize } = require('../src/main/execute');
  {
    const vs = new VariableStore();
    const seq = [];
    const chatSeq = async ({ messages, tools }) => {
      const directive = messages.filter((m) => m.role === 'user').pop().content;
      if (/CURRENT STEP/.test(directive)) return { text: 'sequential step done', toolCalls: [] };
      return { text: 'final synthesized answer', toolCalls: [] };
    };
    const out = await executePlan({
      chat: chatSeq, callTool: async () => ({ text: '{}' }), model: 'mock',
      plan: { goal: 'mixed', steps: [{ id: 1, task: 'parallel research', parallel: true, agent: 'auto' }, { id: 2, task: 'use the findings' }] },
      tools: [], store: vs, stepBudget: 3,
      runParallel: async (step) => { seq.push('parallel:' + step.id); return { conclusion: JSON.stringify({ case_id: 'C-99', summary: 'found it' }) }; }
    });
    assert(out.completed && out.stepResults.length === 2 && out.stepResults[0].parallel, 'parallel step handed off to the sub-agent runner');
    assert(vs.get('case_id') === 'C-99', "parallel step's conclusion harvested into shared working memory");

    const syn = await synthesize({ chat: chatSeq, model: 'mock', plan: { goal: 'mixed' }, stepResults: out.stepResults, store: vs, history: [] });
    assert(syn.reply === 'final synthesized answer', 'synthesize produces the final answer over mixed results');

    const single = await synthesize({ chat: chatSeq, model: 'mock', plan: { goal: 'g' }, stepResults: [{ step: 1, task: 't', conclusion: 'the answer' }], store: vs });
    assert(single.reply === 'the answer', 'single completed step passes through without an extra model call');
  }

  // ── Read-time skill healing (skill-content.js) ─────────────────────────────
  const { extractSkill, enrichSkillRow } = require('../src/main/skill-content');
  {
    // (a) The stale shape found in production: a raw skills_update delivery
    // envelope stored as the definition, description NULL.
    const skillMd = '---\nname: fluency-case-investigation\ndescription: >-\n  Investigate a Fluency case and produce\n  the standard report.\nmcp_functions:\n  - get_case\n  - expand_case\n---\n# Workflow\n1. Resolve the case\n2. Expand and analyze\n3. Produce the report';
    const envelope = JSON.stringify({ delivery_contract: '1.0.0', items: [{ name: 'fluency-case-investigation', files: [{ path: 'SKILL.md', content: skillMd }, { path: 'references/facets.md', content: 'reference noise' }] }] });
    const row = enrichSkillRow(
      { name: 'fluency-case-investigation', description: null, definition: envelope, tools: null },
      ['fluency__get_case', 'fluency__expand_case', 'fluency__kql_search']
    );
    assert(/^# Workflow/.test(row.definition) && !row.definition.includes('delivery_contract'), 'envelope definition healed to the SKILL.md body');
    assert(/Investigate a Fluency case/.test(row.description), 'NULL description healed from frontmatter');
    assert(row.tools.length === 2 && row.tools[0] === 'fluency__get_case', 'mcp_functions recovered as a tool scope (suffix-matched to connected tools)');

    // (b) A frontmattered SKILL.md stored directly — body extracted, meta read.
    const direct = extractSkill(skillMd);
    assert(/^# Workflow/.test(direct.body) && direct.meta.description.includes('standard report'), 'direct SKILL.md: body + frontmatter meta extracted');

    // (c) Plain text passes through untouched; authored fields never clobbered.
    const plain = enrichSkillRow({ name: 'x', description: 'authored', definition: 'just instructions', tools: ['t1'] }, ['t1']);
    assert(plain.definition === 'just instructions' && plain.description === 'authored' && plain.tools[0] === 't1', 'plain/authored rows pass through enrichment unchanged');
  }

  // Stuck step's partial conclusion reaches the re-planner (desk-check fix).
  {
    const looping2 = async ({ tools }) => tools.length
      ? { text: '', toolCalls: [{ id: 'x', name: 'search', args: {} }] }
      : { text: 'half the picture', toolCalls: [] };
    let seenPartial = null;
    await executePlan({
      chat: looping2, callTool: async () => ({ text: '{}' }), model: 'mock',
      plan: { goal: 'g', steps: [{ id: 1, task: 'dig' }] },
      tools: [{ name: 'search', description: '', inputSchema: {} }],
      store: new VariableStore(), stepBudget: 1, replanBudget: 1,
      refinePlan: async ({ partial }) => { seenPartial = partial; return { steps: [] }; },
      onStuck: async () => ({ continue: false })
    });
    assert(seenPartial === 'half the picture', "refinePlan receives the stuck step's partial conclusion");
  }

  console.log('\nALL SMOKE TESTS PASSED');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
}).catch((err) => {
  console.error('\nSMOKE TEST ERROR:', err);
  app.exit(1);
});
