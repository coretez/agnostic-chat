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

  // Skills scoped per project
  const skillDocs = repo.skills.create({ name: 'docx', description: 'Word docs' });
  const skillSec = repo.skills.create({ name: 'security-review', description: 'security' });
  repo.skills.setForProject({ projectId: projA.id, skillId: skillDocs.id, enabled: true });
  repo.skills.setForProject({ projectId: projB.id, skillId: skillSec.id, enabled: true });
  const aSkills = repo.skills.listEnabledForProject(projA.id);
  assert(aSkills.length === 1 && aSkills[0].name === 'docx', 'projA sees only its enabled skill');
  assert(repo.skills.listEnabledForProject(projB.id)[0].name === 'security-review', 'projB scoped separately');

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
