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
const { buildCodingTools, hasGit, commitStep } = require('../src/main/coding-tools');
const projectDocs = require('../src/main/project-docs');
const { planContext } = require('../src/main/plan-derive');
const { DEFAULT_TEMPLATE } = require('../src/main/documents');
const { spawnSync } = require('node:child_process');

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
      connector: mkConnector({
        simple: false, goal: 'monthly report',
        steps: [
          { task: 'find the tenant id', produces: 'tenant_id' },
          { task: 'pull the raw report', delegate: true, agent: 'report-reader' },
          { task: 'write the summary', parallel: false }
        ],
        merge: 'Present as the standard monthly report: summary table first, then findings.'
      }),
      model: 'mock', userText: 'make the monthly report', loadedSkills: [{ name: 'reporting', definition: 'steps: find tenant, run report' }], tools: [{ name: 'run_report' }], store: new VariableStore()
    });
    assert(!p1.simple && p1.steps.length === 3 && p1.steps[0].id === 1 && p1.steps[2].id === 3, 'derivePlan returns a well-formed ordered plan');
    assert(p1.steps[0].produces === 'tenant_id', 'plan steps carry produces (declared outputs)');
    assert(p1.steps[1].parallel === true && p1.steps[1].agent === 'report-reader', 'delegate=true marks the step for isolated sub-agent handoff with its agent');
    assert(/summary table first/.test(p1.merge), 'plan carries the merge instruction');

    const p2 = await derivePlan({ connector: mkConnector({ simple: true, goal: 'greet' }), model: 'mock', userText: 'hi', loadedSkills: [], tools: [{ name: 'x' }], store: new VariableStore() });
    assert(p2.simple, 'derivePlan trivial-turn gate: simple=true routes to the flat loop');

    const p3 = await derivePlan({ connector: mkConnector({ simple: false, goal: 'g', steps: [{ task: 'only one' }] }), model: 'mock', userText: 't', loadedSkills: [], tools: [], store: new VariableStore() });
    assert(p3.simple, 'derivePlan gate: a 1-step plan is treated as simple (nothing to orchestrate)');

    const pFail = await derivePlan({ connector: { chat: async () => { throw new Error('boom'); } }, model: 'mock', userText: 't', loadedSkills: [], tools: [], store: new VariableStore() });
    assert(pFail.simple && pFail.error, 'derivePlan failure degrades to simple (flat loop is the worst case)');

    // The planner's tool menu carries descriptions, not bare names.
    let derivePrompt = '';
    await derivePlan({
      connector: { chat: async ({ messages, tools }) => { derivePrompt = messages[0].content; return { text: '', toolCalls: [{ id: 'p', name: tools[0].name, args: { simple: true, goal: 'g' } }] }; } },
      model: 'mock', userText: 'report please', loadedSkills: [],
      tools: [{ name: 'run_report', description: 'Runs a saved FPL report and returns rows.' }], store: new VariableStore()
    });
    assert(derivePrompt.includes('run_report: Runs a saved FPL report'), 'planner tool menu includes descriptions (name — what it does)');

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

    // The plan's merge contract reaches the synthesis prompt (and forces a
    // synthesis call even for a single step, since a format was prescribed).
    let synPrompt = '';
    await synthesize({
      chat: async ({ messages }) => { synPrompt = messages[messages.length - 1].content; return { text: 'merged per contract', toolCalls: [] }; },
      model: 'mock', plan: { goal: 'g', merge: 'Follow the case-investigation report sections exactly.' },
      stepResults: [{ step: 1, task: 't', conclusion: 'raw findings' }], store: vs
    });
    assert(/HOW TO COMBINE THE RESULTS: Follow the case-investigation report sections/.test(synPrompt), 'synthesis honors the plan merge instruction');

    // produces flows into the step directive so the model knows what to record.
    const { renderStepDirective } = require('../src/main/execute');
    const dir = renderStepDirective({ id: 2, task: 'expand the case', produces: 'case_id, expansion_key' }, vs);
    assert(/MUST PRODUCE: case_id, expansion_key/.test(dir) && /set_variable/.test(dir), 'step directive carries produces + set_variable guidance');
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

  // ── STOP (abort + save work) ───────────────────────────────────────────────
  {
    // Flat loop: abort after the first tool round — loop ends without another
    // model call, tool work retained, aborted flagged.
    let flatCalls = 0;
    const flat = await runChatLoop({
      chat: async () => { flatCalls++; return { text: '', toolCalls: [{ id: 'x', name: 'search', args: {} }] }; },
      callTool: async () => ({ text: '{}' }),
      model: 'mock', messages: [{ role: 'user', content: 'dig' }],
      tools: [{ name: 'search', description: '', inputSchema: {} }],
      isAborted: () => flatCalls >= 2   // abort lands mid-round 2
    });
    assert(flat.aborted && flatCalls === 2, 'flat loop: abort ends the loop without further model calls');
    assert(flat.toolTrace.length === 1, "flat loop: round 1's tool work kept; round 2's queued tool never runs");

    // Planned path: abort after step 1 completes — the completed step is kept,
    // the plan is not marked completed, and steps 2/3 never call the model.
    let stepChats = 0; let stop = false;
    const planOut = await executePlan({
      chat: async () => { stepChats++; stop = true; return { text: 'step one done', toolCalls: [] }; },
      callTool: async () => ({ text: '{}' }),
      model: 'mock',
      plan: { goal: 'g', steps: [{ id: 1, task: 'first' }, { id: 2, task: 'second' }, { id: 3, task: 'third' }] },
      tools: [], store: new VariableStore(),
      isAborted: () => stop
    });
    assert(planOut.aborted && !planOut.completed, 'planned path: abort marks the run aborted, not completed');
    assert(stepChats === 1 && planOut.stepResults.length === 1 && planOut.stepResults[0].conclusion === 'step one done', 'planned path: completed step kept, remaining steps never call the model');
  }

  // ── Coding harness: jail (L1), action gating (L2), env scrub, hasGit (L3) ──
  {
    const ctRoot = path.join(tmp, 'ct'); // work + docs (allowed) vs outside (not)
    const work = path.join(ctRoot, 'work'), docsDir = path.join(ctRoot, 'docs'), outside = path.join(ctRoot, 'outside');
    for (const d of [work, docsDir, outside]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-data');

    const asked = [];
    let allow = true;
    const ct = buildCodingTools({ root: work, docsRoot: docsDir, approveAction: async (a) => { asked.push(a.kind); return allow; } });

    // L2: mutations ask; reads don't. L1 runs before L2 ever fires.
    await ct.call('write_file', { path: 'a.txt', content: 'alpha beta\n' });
    assert(asked.length === 1 && asked[0] === 'write', 'coding: write_file asks for approval (L2)');
    const r1 = await ct.call('read_file', { path: 'a.txt' });
    assert(!r1.isError && r1.text.includes('alpha') && asked.length === 1, 'coding: reads are free — no approval asked');
    const docAbs = path.join(docsDir, 'report.md');
    const r2 = await ct.call('write_file', { path: docAbs, content: '# r\n' });
    assert(!r2.isError && fs.existsSync(docAbs), 'coding: docs dir is a second allowed root (absolute path in-jail)');

    // L1: lexical escapes blocked BEFORE any approval.
    const before = asked.length;
    const esc1 = await ct.call('write_file', { path: '../outside/x.txt', content: 'no' });
    const esc2 = await ct.call('read_file', { path: '/etc/passwd' });
    assert(esc1.isError && esc2.isError && asked.length === before, 'coding: jail blocks relative + absolute escapes before asking (L1)');

    // L1: symlink escapes — a link inside the jail pointing outside IS outside.
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(work, 'link.txt'));
    fs.symlinkSync(outside, path.join(work, 'linkdir'));
    const sym1 = await ct.call('read_file', { path: 'link.txt' });
    const sym2 = await ct.call('write_file', { path: 'linkdir/evil.txt', content: 'no' });
    assert(sym1.isError && sym2.isError && !fs.existsSync(path.join(outside, 'evil.txt')), 'coding: symlinked file AND symlinked parent cannot escape the jail');

    // L2 deny: nothing mutates, model told not to retry.
    allow = false;
    const den = await ct.call('edit_file', { path: 'a.txt', old_string: 'alpha', new_string: 'gamma' });
    assert(den.isError && den.text.includes('declined') && fs.readFileSync(path.join(work, 'a.txt'), 'utf8').includes('alpha'), 'coding: denied edit leaves the file untouched');
    allow = true;

    // edit_file exactness: missing + ambiguous matches refuse cleanly.
    await ct.call('write_file', { path: 'b.txt', content: 'dup dup\n' });
    const miss = await ct.call('edit_file', { path: 'b.txt', old_string: 'absent', new_string: 'x' });
    const ambi = await ct.call('edit_file', { path: 'b.txt', old_string: 'dup', new_string: 'x' });
    assert(miss.isError && ambi.isError && ambi.text.includes('2 times'), 'coding: edit_file refuses missing and ambiguous matches');

    // Shell: cwd is the working dir; the app env is scrubbed (allowlist only).
    process.env.SMOKE_LEAK_CANARY = 'should-not-cross';
    const sh = await ct.call('run_command', { command: 'pwd; echo "C=${SMOKE_LEAK_CANARY:-unset}"' });
    delete process.env.SMOKE_LEAK_CANARY;
    assert(!sh.isError && sh.text.includes(fs.realpathSync(work)) && sh.text.includes('C=unset'), 'coding: shell runs in working dir with scrubbed env (no app secrets)');
    const shFail = await ct.call('run_command', { command: 'exit 3' });
    assert(shFail.isError && shFail.text.startsWith('exit 3'), 'coding: non-zero exit reported as an error with the code');

    // L3 gate input: hasGit flips when .git appears (dir or worktree file).
    assert(!hasGit(work), 'coding: hasGit false without a repo');
    fs.mkdirSync(path.join(work, '.git'));
    assert(hasGit(work), 'coding: hasGit true with a .git dir');

    // O5: approvals show the actual change — edit_file summaries carry −/+ lines,
    // write_file overwrite summaries carry the size facts.
    const summaries = [];
    const ct2 = buildCodingTools({ root: work, approveAction: async (a) => { summaries.push(a.summary); return true; } });
    await ct2.call('edit_file', { path: 'a.txt', old_string: 'alpha', new_string: 'omega' });
    assert(summaries[0].includes('- alpha') && summaries[0].includes('+ omega'), 'coding: edit approval shows a −/+ diff (O5)');
    await ct2.call('write_file', { path: 'a.txt', content: 'short\n' });
    assert(/OVERWRITES \d+ bytes/.test(summaries[1]), 'coding: write approval states overwrite + sizes (O5)');
  }

  // ── O7/O8: alignment outcome + recorded decisions (plan-derive) ────────────
  {
    const { derivePlan: dp } = require('../src/main/plan-derive');
    const mockPlanner = (args) => ({ chat: async () => ({ text: '', toolCalls: [{ id: 'p', name: 'submit_plan', args }] }) });

    const aligned = await dp({
      connector: mockPlanner({
        simple: false, goal: 'build the app',
        decisions: [{ question: 'Which platform?', options: ['React Native — one codebase', 'Swift — best iOS feel'], recommendation: 'React Native' }],
        record: [{ key: 'distribution', value: 'internal' }]
      }),
      model: 'mock', userText: 'build me a phone app', codingMode: true
    });
    assert(aligned.align === true && aligned.simple === true && aligned.decisions.length === 1, 'align: coding-mode decisions end planning with an align outcome (O7)');
    assert(aligned.decisions[0].options.length === 2 && aligned.record[0].key === 'distribution', 'align: options + record survive normalization (O8)');

    const notCoding = await dp({
      connector: mockPlanner({ simple: true, goal: 'g', decisions: [{ question: 'Which platform?' }] }),
      model: 'mock', userText: 'x', codingMode: false
    });
    assert(!notCoding.align, 'align: decisions are ignored outside coding mode');

    const docAligned = await dp({
      connector: mockPlanner({ simple: false, goal: 'monthly report', decisions: [{ question: 'Who is the audience?', options: ['CISO', 'engineering'] }] }),
      model: 'mock', userText: 'write the monthly report', documentsMode: true
    });
    assert(docAligned.align === true && docAligned.decisions.length === 1, 'align: documents-mode decisions (audience/format/type) end planning too (O22)');
  }

  // ── O16: fan-out groups + merge contracts (execute.js) ─────────────────────
  {
    const { executePlan } = require('../src/main/execute');
    const { VariableStore } = require('../src/main/variables');
    let inFlight = 0, maxInFlight = 0;
    const runParallel = async (s) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight--;
      return { conclusion: `result-${s.id} case_id: C${s.id}00` };
    };
    const chat = async () => ({ text: 'seq done', toolCalls: [] });
    const groupSteps = [
      { id: 1, task: 'collect a', parallel: true, group: 'collect', agent: 'auto' },
      { id: 2, task: 'collect b', parallel: true, group: 'collect', agent: 'auto' },
      { id: 3, task: 'collect c', parallel: true, group: 'collect', agent: 'auto' }
    ];
    let mergeArgs = null;
    const exec = await executePlan({
      chat, callTool: async () => ({ text: 'ok' }), model: 'm',
      plan: { goal: 'g', steps: [...groupSteps, { id: 4, task: 'analyze the merged product', parallel: false, agent: 'auto' }] },
      tools: [], store: new VariableStore(), history: [], runParallel,
      mergeGroup: async (a) => { mergeArgs = a; return 'MERGED: ' + a.results.map((r) => r.conclusion).join(' | '); }
    });
    assert(maxInFlight >= 2, 'O16: group members run CONCURRENTLY (not awaited one at a time)');
    assert(exec.stepResults.length === 2 && exec.stepResults[0].group === 'collect', 'O16: a fan-out group lands as ONE step-result');
    assert(exec.stepResults[0].conclusion.startsWith('MERGED:') && mergeArgs.results.length === 3, 'O16: the merge contract sees every member result');
    assert(exec.completed && exec.stepResults[1].conclusion === 'seq done', 'O16: sequential steps still run after the group');

    const exec2 = await executePlan({
      chat, callTool: async () => ({ text: 'ok' }), model: 'm',
      plan: { goal: 'g', steps: groupSteps }, tools: [], store: new VariableStore(), history: [], runParallel,
      mergeGroup: async () => { throw new Error('merge died'); }
    });
    assert(exec2.completed && exec2.stepResults[0].conclusion.includes('result-1') && exec2.stepResults[0].conclusion.includes('result-3'),
      'O16: merge failure degrades to concatenation — the group cannot break the turn');

    const { derivePlan: dp16 } = require('../src/main/plan-derive');
    const mock16 = (args) => ({ chat: async () => ({ text: '', toolCalls: [{ id: 'p', name: 'submit_plan', args }] }) });
    const gp = await dp16({
      connector: mock16({ simple: false, goal: 'g', steps: [
        { task: 'a', group: 'Pull' }, { task: 'b', group: 'pull' }, { task: 'c' }
      ], orchestrator: { merge: 'dedupe by case id', on_conflict: 'prefer newest' } }),
      model: 'mock', userText: 'x'
    });
    assert(gp.steps[0].parallel === true && gp.steps[0].group === 'pull' && gp.steps[1].group === 'pull', 'O16: a group implies parallel isolation; names normalize');
    assert(gp.orchestrator && gp.orchestrator.merge === 'dedupe by case id', 'O16: the orchestrator contract survives plan normalization');
  }

  // ── O20: documents-mode library pack — same jail, read-only hands ──────────
  {
    const { buildLibraryTools } = require('../src/main/coding-tools');
    const lib = path.join(tmp, 'doc-library');
    fs.mkdirSync(path.join(lib, 'acme', 'monthly-reports'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'acme', 'monthly-reports', 'aug.md'), '# August\nfindings: clean\n');
    const lt = buildLibraryTools({ root: lib });

    assert(lt.tools.length === 3 && !lt.names.has('write_file') && !lt.names.has('run_command'), 'library: pack is read-only — no write or shell tools offered');
    const lr = await lt.call('read_file', { path: 'acme/monthly-reports/aug.md' });
    assert(!lr.isError && lr.text.includes('findings: clean'), 'library: reads resolve against the library root');
    const ll = await lt.call('list_dir', { depth: 3 });
    assert(!ll.isError && ll.text.includes('aug.md'), 'library: list_dir walks the library tree');
    const lg = await lt.call('grep_files', { pattern: 'findings' });
    assert(!lg.isError && lg.text.includes('aug.md:2'), 'library: grep_files searches document contents');
    const lesc1 = await lt.call('read_file', { path: '../outside/secret.txt' });
    const lesc2 = await lt.call('read_file', { path: '/etc/passwd' });
    assert(lesc1.isError && lesc2.isError, 'library: jail blocks relative + absolute escapes (single root)');
    const lw = await lt.call('write_file', { path: 'x.md', content: 'no' });
    assert(lw.isError && lw.text.includes('unknown'), 'library: write_file is not a library tool — refused, nothing written');
  }

  // ── O9: step-commits — the plan is the git history ─────────────────────────
  {
    const repoDir = path.join(tmp, 'o9-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    const g = (...a) => spawnSync('git', a, { cwd: repoDir });
    g('init'); g('config', 'user.email', 's@smoke'); g('config', 'user.name', 'smoke');
    fs.writeFileSync(path.join(repoDir, 'f.txt'), 'v1\n');
    const c1 = await commitStep(repoDir, 'step 1: create f.txt');
    assert(c1.committed, 'commitStep: dirty tree commits');
    const c2 = await commitStep(repoDir, 'step 2: nothing');
    assert(!c2.committed && c2.reason === 'clean tree', 'commitStep: clean tree is a no-op');
    const log = spawnSync('git', ['log', '--format=%s'], { cwd: repoDir }).stdout.toString();
    assert(log.includes('step 1: create f.txt'), "commitStep: the step's produces is the commit message (O9)");
    const c3 = await commitStep(path.join(tmp, 'not-a-repo-xyz'), 'x');
    assert(!c3.committed, 'commitStep: non-repo resolves false, never throws');

    // executePlan fires onStepComplete with the step's own tool trace.
    const { executePlan: ep } = require('../src/main/execute');
    const { VariableStore: VS } = require('../src/main/variables');
    const seen = [];
    await ep({
      chat: async ({ messages }) => (messages.some((m) => String(m.content || '').includes('STEP (2)'))
        ? { text: 'done2', toolCalls: [] }
        : (messages.filter((m) => m.role === 'tool').length ? { text: 'done1', toolCalls: [] } : { text: '', toolCalls: [{ id: 't1', name: 'write_file', args: { path: 'x' } }] })),
      callTool: async () => ({ text: 'ok' }),
      model: 'mock',
      plan: { goal: 'g', steps: [{ id: 1, task: 'write', produces: 'x file' }, { id: 2, task: 'read' }] },
      tools: [{ name: 'write_file', description: '', inputSchema: {} }],
      store: new VS(),
      onStepComplete: (step, r, trace) => { seen.push({ id: step.id, mutated: (trace || []).some((t) => t.name === 'write_file') }); }
    });
    assert(seen.length === 2 && seen[0].id === 1 && seen[0].mutated && !seen[1].mutated, 'executePlan: onStepComplete fires per step with that step\'s trace (O9)');
  }

  // ── O15: canonical doc set — designed docs/ tree, bootstrapped + maintained ──
  {
    const proj = repo.projects.create({ name: 'DocsProj' });
    const outDir = path.join(tmp, 'docs-out');

    // Bootstrap: the full canonical set appears at docs/<NAME>.md, indexed.
    const created = projectDocs.ensureCanonicalDocs({ projectId: proj.id, docsBase: outDir });
    assert(created.length === 4, 'O15: bootstrap creates all four canonical docs');
    for (const t of ['SPEC', 'DESIGN', 'PSEUDOCODE', 'KNOWLEDGE']) {
      assert(fs.existsSync(path.join(outDir, 'docs', `${t}.md`)), `O15: docs/${t}.md exists at its designed location`);
    }
    assert(fs.readFileSync(path.join(outDir, 'docs', 'SPEC.md'), 'utf8').includes('## Decision records'), 'O15: SPEC skeleton is structured, not an empty page');
    assert(projectDocs.ensureCanonicalDocs({ projectId: proj.id, docsBase: outDir }).length === 0, 'O15: bootstrap is idempotent — existing docs untouched');
    assert(repo.documents.listByProject(proj.id).filter((d) => projectDocs.CANONICAL[d.doc_type]).length === 4, 'O15: all four indexed in the documents library');

    // Ratified decisions append to the SPEC as dated decision records.
    const w1 = projectDocs.appendDecisions({ projectId: proj.id, docsBase: outDir, records: [{ key: 'platform', value: 'react-native' }], goal: 'SIEM status app' });
    assert(fs.readFileSync(w1.absPath, 'utf8').includes('**platform** = react-native'), 'O15: ratified decision lands in SPEC as a decision record');

    // Later decisions accrete on the SAME document — version bump, prior kept.
    const w2 = projectDocs.appendDecisions({ projectId: proj.id, docsBase: outDir, records: [{ key: 'distribution', value: 'internal' }] });
    const specText = fs.readFileSync(w2.absPath, 'utf8');
    assert(w2.version === w1.version + 1 && specText.includes('platform') && specText.includes('distribution'), 'O15: later decisions append + version-bump the same SPEC doc');
    assert(fs.existsSync(path.join(path.dirname(w2.absPath), '.versions')), 'O15: prior SPEC versions preserved in docs/.versions/');

    // Canonical writes route to the fixed path (what save_document uses).
    const wc = projectDocs.writeCanonical({ projectId: proj.id, docsBase: outDir, docType: 'design', content: '# DESIGN\nupdated', source: 'chat' });
    assert(wc.absPath === projectDocs.canonicalPath(outDir, 'design') && wc.version === 2, 'O15: canonical write versions the fixed docs/DESIGN.md, never a new bin file');

    // Empty records are a no-op (no doc churn on plain plans).
    assert(projectDocs.appendDecisions({ projectId: proj.id, docsBase: outDir, records: [] }).added === 0, 'O15: no decisions → no doc write');

    // The planner reads the docs back as its source of truth.
    const block = projectDocs.load(proj.id);
    assert(block.includes('SPEC') && block.includes('react-native'), 'O15: load() returns the canonical docs for planning');
    const pctx = planContext({ projectDocs: block });
    assert(pctx.includes('PROJECT DOCUMENTATION') && pctx.includes('not by exploring code') && pctx.includes('react-native'), 'O15: planner context carries docs under the source-of-truth banner');
    assert(planContext({}).includes('PROJECT DOCUMENTATION') === false, 'O15: no docs → no empty banner in the planner context');
  }

  // ── Project-scoped MCP servers (opt-out, mirrors project_skills) ───────────
  {
    const proj = repo.projects.create({ name: 'ScopeProj' });
    const s1 = repo.mcp.add({ name: 'siem', transport: 'http', url: 'https://example.test/a' });
    const s2 = repo.mcp.add({ name: 'crm', transport: 'http', url: 'https://example.test/b' });

    let enabled = repo.mcp.listEnabledForProject(proj.id).map((s) => s.name);
    assert(enabled.includes('siem') && enabled.includes('crm'), 'project mcp: no rows → all servers enabled (opt-out default)');

    repo.mcp.setForProject({ projectId: proj.id, serverId: s2.id, enabled: false });
    enabled = repo.mcp.listEnabledForProject(proj.id).map((s) => s.name);
    assert(enabled.includes('siem') && !enabled.includes('crm'), 'project mcp: enabled=0 row excludes that server for this project');

    const other = repo.projects.create({ name: 'OtherProj' });
    assert(repo.mcp.listEnabledForProject(other.id).map((s) => s.name).includes('crm'), 'project mcp: exclusion is per-project, other projects unaffected');

    repo.mcp.setForProject({ projectId: proj.id, serverId: s2.id, enabled: true });
    assert(repo.mcp.listEnabledForProject(proj.id).length === repo.mcp.list().length, 'project mcp: re-enable restores the full catalog');
    assert(!('secret_ciphertext' in repo.mcp.listEnabledForProject(proj.id)[0]), 'project mcp: scoped rows never carry ciphertext');
    repo.mcp.remove(s1.id); repo.mcp.remove(s2.id);
  }

  // ── Doc-writer: the technical-writer pass (deterministic trigger, strict IO) ──
  {
    const { updateDocs } = require('../src/main/doc-writer');
    let seenPrompt = '';
    const mock = (reply) => ({ chat: async ({ messages }) => { seenPrompt = messages[0].content; return reply; } });

    const good = '# DESIGN — Architecture & Interfaces\n\n## Module map\n- cli — arg parsing\n';
    const out = await updateDocs({
      connector: mock({ toolCalls: [{ id: 'x', name: 'submit_docs', args: { design: good, knowledge: 'not markdown', none: false } }] }),
      model: 'mock', goal: 'add flag',
      stepResults: [{ step: 1, task: 'edit cli.js', conclusion: 'added --verbose' }],
      toolTrace: [{ name: 'edit_file', args: { path: 'cli.js' }, ok: true }, { name: 'run_command', args: { command: 'npm test' }, ok: true }],
      known: 'KNOWN VALUES: x', current: { design: '# DESIGN old', pseudocode: '', knowledge: '# K' }
    });
    assert(out.design === good && !out.knowledge && !out.pseudocode, 'doc-writer: valid docs pass, fragments rejected, untouched docs omitted');
    assert(seenPrompt.includes('technical writer') && seenPrompt.includes('Never narrate') && seenPrompt.includes('cli.js') && seenPrompt.includes('# DESIGN old'), 'doc-writer: prompt carries standards, files touched, and current docs');
    const none = await updateDocs({ connector: mock({ toolCalls: [{ id: 'x', name: 'submit_docs', args: { none: true, design: good } }] }), model: 'mock', current: {} });
    assert(Object.keys(none).length === 0, 'doc-writer: none=true wins — no writes');
    const fail = await updateDocs({ connector: { chat: async () => { throw new Error('boom'); } }, model: 'mock', current: {} });
    assert(Object.keys(fail).length === 0, 'doc-writer: model failure degrades to no-op, never degrades docs');
  }

  // ── Record junk filter: decisions are short snake_case, never task prose ──
  {
    const { derivePlan } = require('../src/main/plan-derive');
    const mockChat = { chat: async () => ({ toolCalls: [{ id: 'p', name: 'submit_plan', args: { simple: true, goal: 'g', record: [
      { key: 'platform', value: 'react-native' },
      { key: 'project', value: 'Agnostic Chat-Code Project website — a long restated task description that is not a decision at all and rambles on' },
      { key: 'Project Title', value: 'x' }
    ] } }] }) };
    const p = await derivePlan({ connector: mockChat, model: 'mock', userText: 'u', tools: [], store: new VariableStore(), loadedSkills: [], agents: [] });
    assert(p.record.length === 2 && p.record[0].key === 'platform' && p.record[1].key === 'project_title', 'record filter: long task-prose values dropped, keys normalized to snake_case');
  }

  // ── Canonical-path migration: old bin rows re-pointed to docs/<NAME>.md ──
  {
    const proj = repo.projects.create({ name: 'MigrateProj' });
    const outDir = path.join(tmp, 'migrate-out');
    const oldPath = path.join(outDir, 'documents', 'spec', 'spec.md');
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, '# SPEC old\n\n## Decision records\n- old decision\n');
    repo.documents.saveGenerated({ projectId: proj.id, title: 'SPEC', path: oldPath, mimeType: 'text/markdown', source: 'pipeline', docType: 'spec', version: 1 });
    projectDocs.ensureCanonicalDocs({ projectId: proj.id, docsBase: outDir });
    const specRow = repo.documents.listByProject(proj.id).find((d) => d.doc_type === 'spec');
    assert(specRow.path === projectDocs.canonicalPath(outDir, 'spec'), 'migration: spec row re-pointed to docs/SPEC.md');
    assert(fs.readFileSync(specRow.path, 'utf8').includes('old decision') && !fs.existsSync(oldPath), 'migration: old content moved to the designed location, bin file removed');
  }

  // ── Coding-mode planning discipline: plan-by-default + real-file map ──────
  {
    const { DERIVE_PROMPT } = require('../src/main/plan-derive');
    const coded = DERIVE_PROMPT('ctx', 'req', true);
    assert(coded.includes('PLAN BY DEFAULT') && coded.includes('NEVER return simple=true'), 'coding rules: mutating requests are never simple (plan-by-default)');
    assert(coded.includes('stages, phases, or an ordered sequence') && coded.includes('documentation, or a recommendation rather than code'), 'coding rules: staged/design requests plan too, even when the deliverable is prose');
    assert(DERIVE_PROMPT('ctx', 'req', false).includes('PLAN BY DEFAULT') === false, 'coding rules: plan-by-default applies only in coding mode');
    const docRules = DERIVE_PROMPT('ctx', 'req', false, true);
    assert(docRules.includes('AUDIENCE') && docRules.includes('save_document') && docRules.includes('COLLECT IN PARALLEL'), 'documents rules: align on audience/format/type, save_document contract, parallel collection (O22)');
    assert(docRules.includes('VERIFY') && docRules.includes('versioning is automatic'), 'documents rules: verify step required; revise over recreate');
    assert(DERIVE_PROMPT('ctx', 'req', false, false).includes('AUDIENCE') === false, 'documents rules: issued only in documents mode');
    const ctx = planContext({ repoMap: 'cli.js\ntest/cli.test.js' });
    assert(ctx.includes('WORKING DIRECTORY MAP') && ctx.includes('real files') && ctx.includes('cli.js'), 'planner context: working-directory map feeds Pass 2 so steps name real paths');
  }

  // ── Review pass (O11 v1): two lenses, validated findings, worst-first ─────
  {
    const { reviewChanges } = require('../src/main/review');
    const files = [{ path: 'cli.js', content: 'var x = eval(input);' }];
    let lensCount = 0;
    const conn = { chat: async ({ messages }) => {
      lensCount++;
      const isSec = messages[0].content.includes('security reviewer');
      return { toolCalls: [{ id: 'r', name: 'submit_review', args: { findings: isSec
        ? [{ severity: 'high', file: 'cli.js', issue: 'eval on external input', fix: 'parse explicitly' },
           { severity: 'low', file: 'cli.js', issue: 'nit', fix: 'x' },
           { severity: 'med', file: 'other.js', issue: 'speculation about unseen file', fix: 'x' }]
        : [{ severity: 'med', file: 'cli.js', issue: 'duplicated parse block', fix: 'extract helper' },
           { severity: 'med', file: 'cli.js', issue: 'duplicated parse block', fix: 'extract helper' }] } }] };
    } };
    const rev = await reviewChanges({ connector: conn, model: 'mock', files, goal: 'g' });
    assert(lensCount === 2, 'review: both lenses run');
    assert(rev.findings.length === 2, 'review: low severity, unseen files, and duplicates all dropped');
    assert(rev.findings[0].severity === 'high' && rev.findings[0].lens === 'security', 'review: findings sorted worst-first');
    const clean = await reviewChanges({ connector: { chat: async () => ({ toolCalls: [{ id: 'r', name: 'submit_review', args: { clean: true, findings: [{ severity: 'high', file: 'cli.js', issue: 'padded' }] } }] }) }, model: 'mock', files, goal: 'g' });
    assert(clean.findings.length === 0, 'review: clean=true wins over padded findings');
    const fail = await reviewChanges({ connector: { chat: async () => { throw new Error('boom'); } }, model: 'mock', files, goal: 'g' });
    assert(fail.findings.length === 0, 'review: model failure degrades to no findings, never breaks the turn');
    const { DERIVE_PROMPT: DP } = require('../src/main/plan-derive');
    assert(DP('c', 'r', true).includes('three layers'), 'coding rules: verify contract states all three layers');
  }

  // ── Web tools: offline parser discipline (network itself not smoke-tested) ──
  {
    const { parseDdg, htmlToText, unwrapDdg } = require('../src/main/web-tools');
    const ddg = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=x">Example <b>Docs</b></a>'
      + '<td class="result__snippet">The &amp;official&amp; docs</td>'
      + '<a class="result__a" href="javascript:void(0)">junk</a>'
      + '<a class="result__a" href="https://direct.example.org/page">Direct</a>';
    const r = parseDdg(ddg);
    assert(r.length === 2 && r[0].url === 'https://example.com/docs' && r[0].title === 'Example Docs', 'web: DDG redirect links unwrapped, tags stripped from titles');
    assert(r[1].url === 'https://direct.example.org/page', 'web: non-http schemes dropped, direct links kept');
    assert(r[0].snippet.includes('&official&'), 'web: snippets entity-decoded');
    const txt = htmlToText('<html><script>evil()</script><style>x{}</style><h1>Title</h1><p>Para &amp; more</p><li>item</li></html>');
    assert(!txt.includes('evil') && txt.includes('Title') && txt.includes('Para & more') && txt.includes('- item'), 'web: htmlToText strips scripts/styles, keeps structure');
    assert(unwrapDdg('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.b%2Fc') === 'https://a.b/c', 'web: uddg param decoded');
  }

  // ── Dev servers + build environment ───────────────────────────────────────
  {
    const devServer = require('../src/main/dev-server');
    const wd = path.join(tmp, 'srv'); fs.mkdirSync(wd, { recursive: true });
    const ct2 = buildCodingTools({ root: wd, approveAction: async () => true, buildEnv: { SMOKE_BUILD_VAR: 'yes' }, projectId: 'smoke' });

    // Build env reaches commands; app secrets still do not.
    process.env.SMOKE_SECRET_CANARY = 'leak';
    const e = await ct2.call('run_command', { command: 'echo V=${SMOKE_BUILD_VAR:-unset} C=${SMOKE_SECRET_CANARY:-unset}' });
    delete process.env.SMOKE_SECRET_CANARY;
    assert(e.text.includes('V=yes') && e.text.includes('C=unset'), 'build env: project vars reach commands, app env stays scrubbed');

    // A long-lived process survives the tool call that started it.
    const st = await ct2.call('start_server', { command: 'node -e "console.log(\'listening on http://localhost:9931\'); setInterval(()=>{},1e3)"', wait_seconds: 8 });
    assert(!st.isError && st.text.includes('http://localhost:9931'), 'dev server: starts, stays running, URL detected');
    assert(devServer.status('smoke').running === true, 'dev server: still alive after the tool call returned');
    const lg = await ct2.call('server_logs', { lines: 5 });
    assert(lg.text.includes('listening'), 'dev server: logs captured for diagnosis');
    await ct2.call('stop_server', {});
    assert(devServer.status('smoke').running === false, 'dev server: stop_server ends it');

    // A process that dies immediately is reported as an error with its output.
    const bad = await ct2.call('start_server', { command: 'node -e "console.error(\'boom\'); process.exit(1)"', wait_seconds: 6 });
    assert(bad.isError && bad.text.includes('boom'), 'dev server: failed start reported with its output');
    devServer.disposeAll();
  }

  // ── Project facts: common coding variables captured deterministically ─────
  {
    const facts = require('../src/main/project-facts');
    const store = new VariableStore();
    facts.capture(store, { name: 'start_server', args: { command: 'npm run dev -- --port 3111' }, text: 'ready - Local: http://localhost:3111', ok: true });
    assert(store.get('dev_server_url') === 'http://localhost:3111' && store.get('dev_server_port') === '3111', 'facts: dev server URL + port captured from the server output');
    assert(store.get('dev_command') === 'npm run dev -- --port 3111' && store.get('package_manager') === 'npm', 'facts: dev command and package manager captured');

    facts.capture(store, { name: 'run_command', args: { command: 'npm test' }, text: 'ok', ok: true });
    facts.capture(store, { name: 'run_command', args: { command: 'npm run build' }, text: 'ok', ok: true });
    assert(store.get('test_command') === 'npm test' && store.get('build_command') === 'npm run build', 'facts: test and build commands captured from what actually ran');

    // A failing command is not "the way to do it"; a failed start leaves no URL.
    facts.capture(store, { name: 'run_command', args: { command: 'pytest -q' }, text: 'boom', ok: false });
    assert(store.get('test_command') === 'npm test', 'facts: a failed command does not overwrite a working one');
    const s2 = new VariableStore();
    facts.capture(s2, { name: 'start_server', args: { command: 'npm run dev' }, text: 'Error: port in use', ok: false });
    assert(s2.get('dev_server_url') === undefined, 'facts: a failed start records no URL');

    // User-stated values outrank observation (confidence ranking).
    store.set({ key: 'test_command', value: 'npm run test:ci' }, { confidence: 'user', source: 'user' });
    facts.capture(store, { name: 'run_command', args: { command: 'npm test' }, text: 'ok', ok: true });
    assert(store.get('test_command') === 'npm run test:ci', 'facts: user-set value is not overwritten by observation');

    assert(facts.capture(store, { name: 'read_file', args: { path: 'a.js' }, text: 'x', ok: true }).length === 0, 'facts: non-command tools contribute nothing');
  }

  console.log('\nALL SMOKE TESTS PASSED');
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
}).catch((err) => {
  console.error('\nSMOKE TEST ERROR:', err);
  app.exit(1);
});
