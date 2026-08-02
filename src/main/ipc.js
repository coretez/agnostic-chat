'use strict';

const { ipcMain, shell, dialog, BrowserWindow } = require('electron');
const repo = require('./db/repo');
const { getConnector, testConnection, registryList } = require('./providers');
const { connectAndList } = require('./mcp/client');
const mcpManager = require('./mcp/manager');
const { runAuthFlow } = require('./mcp/oauth');
const { runChatLoop } = require('./chat-loop');
const { runSubagent, mergeResults, DEFAULT_AGENT, DELEGATE_TOOL, ASSIGN_TOOL } = require('./subagent');
const { runEvaluator } = require('./evaluator');
const { selectSkills } = require('./skill-select');
const { maybeCompress, contextWindowFor, renderForSummary, SUMMARY_PROMPT, estimateTokens } = require('./compress');

// ── Context ledger (INTERNALS tab) ──────────────────────────────────────────
// Classify each assembled message into a contributor bucket so the UI can show
// exactly what is occupying the model's context window this turn. Read-only in
// Phase 0 — it reports the pipeline's real output, it does not change it.
function classifyContributor(m) {
  if (m.role === 'system') {
    const c = m.content || '';
    if (c.startsWith('Summary of earlier conversation')) return 'summary';
    if (c.startsWith('Project skills')) return 'skills';
    return 'system';
  }
  return null; // history/current decided by position
}

function buildLedger({ convo, tools, model, compressed, tokensBefore, skillSelect }) {
  const buckets = { system: 0, skills: 0, summary: 0, history: 0, current: 0, tools: 0 };
  const nonSystem = convo.filter((m) => m.role !== 'system');
  const lastNonSystem = nonSystem[nonSystem.length - 1];
  for (const m of convo) {
    const t = estimateTokens([m]);
    const bucket = classifyContributor(m);
    if (bucket) buckets[bucket] += t;
    else if (m === lastNonSystem) buckets.current += t;
    else buckets.history += t;
  }
  buckets.tools = tools && tools.length ? Math.ceil(JSON.stringify(tools).length / 4) : 0;

  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  const window = contextWindowFor(model);
  const contributors = Object.entries(buckets)
    .filter(([, v]) => v > 0)
    .map(([key, tokens]) => ({ key, tokens }));

  const events = [];
  if (skillSelect && !skillSelect.inlined) {
    events.push({ type: 'skill-select', available: skillSelect.available, selected: (skillSelect.selected || []).length, saved: skillSelect.savedTokens || 0, error: skillSelect.error });
  }
  if (compressed) {
    const after = estimateTokens(convo);
    events.push({ type: 'compact', tokensBefore, tokensAfter: after, saved: Math.max(0, tokensBefore - after) });
  }

  // The exact message list handed to the model (large individual messages capped
  // for transport, with a note — the point is faithful visibility).
  const CAP = 20000;
  const assembled = convo.map((m) => {
    const content = m.content || '';
    const clipped = content.length > CAP;
    return {
      role: m.role,
      contributor: classifyContributor(m) || (m === lastNonSystem ? 'current' : 'history'),
      tokens: estimateTokens([m]),
      content: clipped ? content.slice(0, CAP) : content,
      clippedChars: clipped ? content.length - CAP : 0,
      toolCalls: (m.toolCalls || []).map((t) => t.name)
    };
  });

  return { type: 'internals', model, window, total, contributors, events, assembled, toolCount: tools ? tools.length : 0, skillSelect: skillSelect || null };
}

/**
 * Register all IPC handlers. Each channel maps to a repo call.
 *
 * Security note: credentials.reveal (plaintext) is intentionally NOT exposed
 * here — secrets are decrypted only inside the main process when making a
 * provider call, never handed to the renderer.
 */
// Tolerant parser for a skills_update payload (JSON array / {skills:[]} / keyed
// object / plain text). Refined once we see the real Fluency output.
function parseSkillsPayload(text) {
  if (!text) return [];
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const norm = (o) => ({
    name: o.name || o.id || o.slug || o.title,
    description: o.description || o.desc || o.summary || null,
    definition: o.definition || o.content || o.body || o.instructions || o.markdown || o.text || null
  });
  const out = [];
  if (Array.isArray(data)) data.forEach((o) => out.push(norm(o)));
  else if (data && Array.isArray(data.skills)) data.skills.forEach((o) => out.push(norm(o)));
  else if (data && typeof data === 'object') for (const [k, v] of Object.entries(data)) { if (v && typeof v === 'object') out.push(norm({ name: k, ...v })); }
  else out.push({ name: 'Imported skill', description: null, definition: text });
  return out.filter((s) => s.name && (s.definition || s.description));
}

// Parse version_check output into a list of skill names.
// Fluency shape: { skills: { skills_root, count, items: [{name, version, ...}], missing_version } }
function parseSkillNames(text) {
  if (!text) return [];
  let d = null; try { d = JSON.parse(text); } catch {}
  if (!d) return [];
  const buckets = [];
  const sk = d.skills;
  if (sk && Array.isArray(sk.items)) buckets.push(sk.items);
  else if (sk && Array.isArray(sk.list)) buckets.push(sk.list);
  else if (Array.isArray(sk)) buckets.push(sk);
  if (Array.isArray(d.items)) buckets.push(d.items);
  const names = new Set();
  for (const arr of buckets) for (const o of arr) {
    if (typeof o === 'string') names.add(o);
    else if (o && (o.name || o.slug || o.id || o.skill)) names.add(o.name || o.slug || o.id || o.skill);
  }
  return [...names].filter(Boolean);
}

function registerIpc() {
  // Projects
  ipcMain.handle('projects:list', (_e, opts) => repo.projects.list(opts));
  ipcMain.handle('projects:create', (_e, input) => repo.projects.create(input));
  ipcMain.handle('projects:rename', (_e, { id, name }) => repo.projects.rename(id, name));
  ipcMain.handle('projects:archive', (_e, { id }) => repo.projects.archive(id));
  ipcMain.handle('projects:setWorkingDir', (_e, { id, dir }) => repo.projects.setWorkingDir(id, dir));
  // Native folder picker → set the project's working directory.
  ipcMain.handle('projects:pickWorkingDir', async (_e, { id }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const cur = repo.projects.get(id);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose working directory',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: cur && cur.working_dir ? cur.working_dir : undefined
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    return { ok: true, project: repo.projects.setWorkingDir(id, res.filePaths[0]) };
  });
  ipcMain.handle('app:revealPath', (_e, p) => { if (p) shell.openPath(p); });
  ipcMain.handle('projects:setPreferredModel', (_e, { id, model }) => repo.projects.setPreferredModel(id, model));

  // Agents (authored per-project sub-agent definitions)
  ipcMain.handle('agents:list', (_e, { projectId }) => repo.agents.listByProject(projectId));
  ipcMain.handle('agents:create', (_e, input) => repo.agents.create(input));
  ipcMain.handle('agents:update', (_e, { id, patch }) => repo.agents.update(id, patch));
  ipcMain.handle('agents:remove', (_e, { id }) => repo.agents.remove(id));

  // Turn metrics (telemetry) — read-only for the readout + trend view
  ipcMain.handle('metrics:listByChat', (_e, { chatId }) => repo.metrics.listByChat(chatId));
  ipcMain.handle('metrics:listByProject', (_e, { projectId }) => repo.metrics.listByProject(projectId));

  // Settings (small key/value store; project_id null = global)
  ipcMain.handle('settings:get', (_e, { key, projectId = null }) => repo.settings.get(key, projectId));
  ipcMain.handle('settings:set', (_e, { key, value, projectId = null }) => repo.settings.set(key, value, projectId));

  // Meta-evaluator — critique a turn's context engineering with a chosen model.
  ipcMain.handle('evaluate:run', async (_e, { providerId, model, digest }) => {
    const provider = repo.providers.get(providerId);
    if (!provider) return { error: 'Evaluator connection no longer exists.', findings: [] };
    if (!provider.enabled) return { error: `${provider.label || provider.type} is disabled.`, findings: [] };
    const key = repo.providers.reveal(providerId);
    if (!key) return { error: `No API key stored for ${provider.label || provider.type}.`, findings: [] };
    try {
      const connector = getConnector(provider, key);
      return await runEvaluator({ connector, model: model || provider.default_model, digest });
    } catch (e) {
      return { error: e && e.message ? e.message : 'evaluation failed', findings: [] };
    }
  });

  // Chats & messages
  ipcMain.handle('chats:list', (_e, { projectId }) => repo.chats.listByProject(projectId));
  ipcMain.handle('chats:create', (_e, input) => repo.chats.create(input));
  ipcMain.handle('chats:rename', (_e, { id, title }) => repo.chats.rename(id, title));
  ipcMain.handle('chats:setModel', (_e, { id, model }) => repo.chats.setModel(id, model));
  ipcMain.handle('chats:archive', (_e, { id }) => repo.chats.archive(id));
  ipcMain.handle('messages:list', (_e, { chatId }) => repo.messages.listByChat(chatId));
  ipcMain.handle('messages:add', (_e, input) => repo.messages.add(input));

  // Documents (project-scoped) + chat links
  ipcMain.handle('documents:list', (_e, { projectId }) => repo.documents.listByProject(projectId));
  ipcMain.handle('documents:create', (_e, input) => repo.documents.create(input));
  ipcMain.handle('documents:linkToChat', (_e, input) => repo.documents.linkToChat(input));
  ipcMain.handle('documents:listByChat', (_e, { chatId }) => repo.documents.listByChat(chatId));

  // Skills + per-project scoping
  ipcMain.handle('skills:list', () => repo.skills.list());
  ipcMain.handle('skills:create', (_e, input) => repo.skills.create(input));
  ipcMain.handle('skills:enabledForProject', (_e, { projectId }) =>
    repo.skills.listEnabledForProject(projectId)
  );
  ipcMain.handle('skills:setForProject', (_e, input) => repo.skills.setForProject(input));
  ipcMain.handle('skills:update', (_e, { id, patch }) => repo.skills.update(id, patch));
  ipcMain.handle('skills:remove', (_e, { id }) => repo.skills.remove(id));

  // Import skills from a connected MCP server's `skills_update` tool.
  ipcMain.handle('skills:importFromMcp', async (_e, { serverId } = {}) => {
    const emit = (p) => { try { _e.sender.send('skills:progress', p); } catch {} };
    let ts;
    try { ts = await mcpManager.buildToolset(); } catch (e) { return { ok: false, error: e.message }; }
    const pick = (suffix) => ts.tools.find((t) => t.name.endsWith(suffix) && (!serverId || (ts.routes.get(t.name) || {}).serverId === serverId));
    const vc = pick('__version_check');
    const su = pick('__skills_update');
    if (!su) return { ok: false, error: 'That MCP server does not expose a skills_update tool (or it is not connected — sign in first).' };

    // 1) Get the list of available skills (small) via version_check.
    emit({ phase: 'list' });
    let names = [];
    if (vc) {
      try {
        const r = await mcpManager.callTool(vc.name, { client: 'claude' }, ts.routes);
        console.log('[skills import] version_check (first 500):', (r.text || '').slice(0, 500));
        names = parseSkillNames(r.text);
      } catch (e) { console.error('[skills import] version_check', e && e.message); }
    }

    // 2) Fetch + install each skill individually (avoids the giant payload).
    const installed = [];
    if (names.length) {
      emit({ phase: 'list-done', total: names.length });
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        emit({ phase: 'install', name, done: i, total: names.length });
        try {
          const r = await mcpManager.callTool(su.name, { skill_names: [name], client: 'claude' }, ts.routes);
          if (i === 0) console.log('[skills import] per-skill skills_update sample (first 500):', (r.text || '').slice(0, 500));
          const parsed = parseSkillsPayload(r.text);
          for (const s of parsed) { const nm = s.name || name; repo.skills.upsertByName({ ...s, name: nm }); if (!installed.includes(nm)) installed.push(nm); }
          if (!parsed.length) installed.push(name), repo.skills.upsertByName({ name, definition: r.text });
        } catch (e) { console.error('[skills import] fetch', name, e && e.message); emit({ phase: 'error', name, error: e.message }); }
      }
    } else {
      // Fallback: no parseable list — pull the bundle once (main-side parse; never hits the model).
      emit({ phase: 'bulk' });
      try {
        const r = await mcpManager.callTool(su.name, { client: 'claude' }, ts.routes);
        console.log('[skills import] bulk skills_update (first 500):', (r.text || '').slice(0, 500));
        const parsed = parseSkillsPayload(r.text);
        for (let i = 0; i < parsed.length; i++) { const s = parsed[i]; if (!s.name) continue; emit({ phase: 'install', name: s.name, done: i, total: parsed.length }); repo.skills.upsertByName(s); installed.push(s.name); }
      } catch (e) { return { ok: false, error: e.message }; }
    }

    emit({ phase: 'done', count: installed.length });
    if (!installed.length) return { ok: false, error: 'No skills were returned (raw output logged).' };
    return { ok: true, count: installed.length, names: installed };
  });

  // Credentials — metadata in/out only; plaintext never crosses this boundary.
  ipcMain.handle('credentials:list', (_e, opts) => repo.credentials.list(opts));
  ipcMain.handle('credentials:set', (_e, input) => repo.credentials.set(input));
  ipcMain.handle('credentials:remove', (_e, { id }) => repo.credentials.remove(id));

  // Open an external https link in the user's real browser (validated scheme).
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
  });

  // Providers (model connections) — metadata only out; secrets stay in main.
  ipcMain.handle('providers:registry', () => registryList());
  ipcMain.handle('providers:list', () => repo.providers.list());
  ipcMain.handle('providers:add', (_e, input) => repo.providers.add(input));
  ipcMain.handle('providers:update', (_e, { id, patch }) => repo.providers.update(id, patch));
  ipcMain.handle('providers:remove', (_e, { id }) => repo.providers.remove(id));

  // Test a connection. Accepts { id } (saved) or { type, baseUrl, secret, defaultModel } (unsaved).
  ipcMain.handle('providers:test', async (_e, input) => {
    console.log('[main] providers:test', input && { id: input.id, type: input.type, baseUrl: input.baseUrl, hasSecret: !!input.secret });
    let conn, key;
    if (input.id) {
      conn = repo.providers.get(input.id);
      if (!conn) return { ok: false, error: 'Connection not found' };
      key = repo.providers.reveal(input.id);
    } else {
      conn = { type: input.type, base_url: input.baseUrl, default_model: input.defaultModel };
      key = input.secret;
    }
    if (!key) return { ok: false, error: 'No API key provided' };

    const result = await testConnection(conn, key, input.defaultModel);
    if (input.id) {
      repo.providers.update(input.id, {
        status: result.ok ? 'ok' : 'error',
        statusDetail: result.error || null,
        markChecked: true,
        ...(result.models && result.models.length ? { models: result.models } : {})
      });
    }
    return result;
  });

  // MCP servers — metadata only out; env/token stay in main.
  ipcMain.handle('mcp:list', () => repo.mcp.list());
  ipcMain.handle('mcp:add', (_e, input) => repo.mcp.add(input));
  ipcMain.handle('mcp:update', (_e, { id, patch }) => repo.mcp.update(id, patch));
  ipcMain.handle('mcp:remove', (_e, { id }) => repo.mcp.remove(id));

  // Connect to an MCP server and list its tools. Accepts { id } (saved — uses
  // stored/OAuth token, caches the connection) or an ephemeral config.
  ipcMain.handle('mcp:connect', async (_e, input) => {
    if (input.id) {
      console.log('[main] mcp:connect', { id: input.id });
      const result = await mcpManager.connectAndCache(input.id);
      repo.mcp.update(input.id, {
        status: result.ok ? 'ok' : 'error',
        statusDetail: result.error || null,
        markChecked: true,
        ...(result.ok ? { tools: result.tools || [] } : {})
      });
      return result;
    }
    const cfg = { transport: input.transport, command: input.command, args: input.args, url: input.url, env: input.env, token: input.token };
    console.log('[main] mcp:connect(ephemeral)', { transport: cfg.transport });
    return connectAndList(cfg);
  });

  // OAuth sign-in for a saved http MCP server: runs the flow, stores tokens.
  ipcMain.handle('mcp:authorize', async (_e, { id }) => {
    const s = repo.mcp.get(id);
    if (!s) return { ok: false, error: 'server not found' };
    if (s.transport !== 'http' || !s.url) return { ok: false, error: 'OAuth applies to http servers with a URL' };
    try {
      const tokenSet = await runAuthFlow(s.url, { openExternal: (u) => shell.openExternal(u) });
      console.log('[mcp oauth] signed in — refresh_token:', !!tokenSet.refresh_token, '| expires_at:', tokenSet.expires_at);
      const secret = repo.mcp.reveal(id) || {};
      secret.oauth = tokenSet;
      repo.mcp.update(id, { secret, status: 'ok', statusDetail: 'authorized', markChecked: true });
      return { ok: true, scope: tokenSet.scope };
    } catch (e) {
      console.error('[mcp oauth]', e && (e.stack || e.message));
      repo.mcp.update(id, { status: 'error', statusDetail: `auth: ${e.message || 'failed'}` });
      return { ok: false, error: e.message };
    }
  });

  // Chat — route to the selected provider connection, else fall back to a stub.
  ipcMain.handle('chat:send', async (_e, payload) => {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const providerId = payload?.providerId;
    const model = payload?.model;
    const messages = Array.isArray(payload?.messages) && payload.messages.length
      ? payload.messages
      : [{ role: 'user', content: text }];

    if (providerId) {
      const provider = repo.providers.get(providerId);
      if (!provider) throw new Error('Selected connection no longer exists.');
      if (!provider.enabled) throw new Error(`${provider.label || provider.type} is disabled.`);
      const key = repo.providers.reveal(providerId);
      if (!key) throw new Error(`No API key stored for ${provider.label || provider.type}.`);
      const connector = getConnector(provider, key);
      const chosenModel = model || provider.default_model;
      const fastModel = provider.fast_model || chosenModel;
      const emitProgress = (ev) => { try { _e.sender.send('chat:progress', ev); } catch {} };

      // Skills: enabled = candidate. Always show a cheap MENU; load full definitions
      // only for the skills a selection ACTION picks for this prompt. Small libraries
      // are inlined directly (selection isn't worth an extra call).
      let base = messages;
      const projectId = payload?.projectId;
      let skillSelect = null;
      if (projectId) {
        try {
          const es = repo.skills.listEnabledForProject(projectId);
          if (es.length) {
            const fullTokens = estimateTokens(es.map((s) => ({ content: s.definition || s.description || '' })));
            const SKILL_INLINE_CAP = 6000; // below this, just inline everything
            let toLoad = es;
            if (es.length > 1 && fullTokens > SKILL_INLINE_CAP) {
              try {
                const sel = await selectSkills({ connector, model: fastModel, skills: es, userText: text });
                toLoad = sel.selected;               // may be empty (nothing relevant)
                skillSelect = { available: es.length, selected: sel.names, fullTokens, error: sel.error };
              } catch (e) {
                console.error('[skill-select]', e && e.message);
                toLoad = [];                          // safe: menu still shown, no bulk dump
                skillSelect = { available: es.length, selected: [], fullTokens, error: e.message };
              }
            } else {
              skillSelect = { available: es.length, selected: es.map((s) => s.name), fullTokens, inlined: true };
            }
            const menu = es.map((s) => `- ${s.name}: ${String(s.description || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
            const loaded = toLoad.map((s) => `## ${s.name}\n${s.definition || s.description || ''}`).join('\n\n');
            const loadedTokens = estimateTokens(toLoad.map((s) => ({ content: s.definition || s.description || '' })));
            if (skillSelect) { skillSelect.loadedTokens = loadedTokens; skillSelect.savedTokens = Math.max(0, fullTokens - loadedTokens); }
            const sys = 'Project skills — you can use these. Menu (name — when to use):\n' + menu
              + (loaded ? '\n\nInstructions loaded for this turn:\n\n' + loaded
                        : '\n\n(No skill instructions loaded this turn. If one of the above is needed, say so.)');
            base = [{ role: 'system', content: sys }, ...messages];
            if (skillSelect && !skillSelect.inlined) {
              emitProgress({ type: 'process', kind: 'skill-select', available: skillSelect.available, selected: skillSelect.selected, savedTokens: skillSelect.savedTokens });
            }
          }
        } catch (e) { console.error('[skills inject]', e && e.message); }
      }

      // Compress older history if it nears the model's context window (uses the fast model).
      let convo = base;
      let compressed = false;
      try {
        const out = await maybeCompress({
          messages: base,
          contextWindow: contextWindowFor(chosenModel),
          summarize: async (older) => {
            const r = await connector.chat({ model: fastModel, messages: [{ role: 'user', content: SUMMARY_PROMPT + renderForSummary(older) }], maxTokens: 700 });
            return r.text || '';
          }
        });
        convo = out.messages; compressed = out.compressed;
      } catch (e) { console.error('[compress]', e && e.message); }

      // Gather tools from enabled MCP servers (skips any that fail to connect).
      let toolset = { tools: [], routes: new Map() };
      try { toolset = await mcpManager.buildToolset(); } catch (e) { console.error('[mcp] buildToolset', e && e.message); }

      // Orchestrator gets the MCP tools PLUS `delegate`; sub-agents get the MCP
      // tools only (no `delegate`) so the tree stays one level deep.
      const rawCallTool = (name, args) => mcpManager.callTool(name, args, toolset.routes);

      // Authored per-project agents the orchestrator can delegate to by name.
      let authoredAgents = [];
      try { if (projectId) authoredAgents = repo.agents.listByProject(projectId); } catch (e) { console.error('[agents]', e && e.message); }
      const roster = authoredAgents.length
        ? ` Available named agents for this project: ${authoredAgents.map((a) => `"${a.name}"${a.description ? ` — ${a.description}` : ''}`).join('; ')}. Use "auto" for a general sub-agent.`
        : '';
      const delegateTool = { ...DELEGATE_TOOL, description: DELEGATE_TOOL.description + roster };
      const assignTool = { ...ASSIGN_TOOL, description: ASSIGN_TOOL.description + roster };
      const orchestratorTools = [delegateTool, assignTool, ...toolset.tools];

      // Resolve a delegate target (authored agent by name, else the general one)
      // into the concrete {agent, model, tools} a sub-agent run needs.
      const resolveDelegate = (wanted) => {
        const authored = wanted && wanted !== 'auto'
          ? authoredAgents.find((a) => a.name.toLowerCase() === String(wanted).toLowerCase())
          : null;
        const agent = authored
          ? { name: authored.name, system_prompt: authored.system_prompt || DEFAULT_AGENT.system_prompt }
          : DEFAULT_AGENT;
        const subTools = (authored && authored.tools && authored.tools.length)
          ? toolset.tools.filter((t) => authored.tools.includes(t.name))
          : toolset.tools;
        return { agent, model: (authored && authored.model) || chosenModel, tools: subTools };
      };
      const runOne = async (wanted, task) => {
        const { agent, model: m, tools: subTools } = resolveDelegate(wanted);
        return runSubagent({ connector, model: m, fastModel, agent, task: task || '', tools: subTools, callTool: rawCallTool, onEvent: emitProgress });
      };

      let delegatedCount = 0, delegateAbsorbed = 0; // telemetry: isolation via sub-agents
      const callTool = async (name, args) => {
        if (name === 'delegate') {
          const r = await runOne(args && args.agent, args && args.task);
          delegatedCount += 1; delegateAbsorbed += r.inputTokens || 0;
          return { text: r.conclusion || '(sub-agent returned no conclusion)' };
        }
        if (name === 'assign') {
          // Assign work in parallel, then merge the results.
          const tasks = Array.isArray(args && args.tasks) ? args.tasks.filter((t) => t && t.task) : [];
          if (!tasks.length) return { text: 'assign: no tasks provided', isError: true };
          const results = await Promise.all(tasks.map(async (t) => {
            const r = await runOne(t.agent, t.task);
            delegatedCount += 1; delegateAbsorbed += r.inputTokens || 0;
            return { agent: (resolveDelegate(t.agent).agent.name), task: t.task, conclusion: r.conclusion || '' };
          }));
          if (args && args.merge) {
            const merged = await mergeResults({ connector, model: chosenModel, instruction: args.merge, results, onEvent: emitProgress });
            return { text: merged || '(merge produced nothing)' };
          }
          return { text: results.map((r, i) => `### Result ${i + 1} — ${r.agent}\n${r.conclusion}`).join('\n\n') };
        }
        return rawCallTool(name, args);
      };

      // Emit the pre-call context ledger so the INTERNALS tab can show exactly
      // what is occupying the window this turn (occupancy, compaction, prompt).
      try {
        const tokensBefore = estimateTokens(base);
        _e.sender.send('chat:progress', buildLedger({ convo, tools: orchestratorTools, model: chosenModel, compressed, tokensBefore, skillSelect }));
      } catch (e) { console.error('[internals ledger]', e && e.message); }

      let result;
      try {
        result = await runChatLoop({
          chat: (a) => connector.chat(a),
          callTool,
          model: chosenModel,
          messages: convo,
          tools: orchestratorTools,
          onEvent: emitProgress
        });
      } catch (e) {
        console.error(`[chat] ${provider.type}/${chosenModel} error (${orchestratorTools.length} tools):`, e && e.message);
        throw e;
      }

      // Post-call: report each tool result's size — the raw material for Phase 1
      // (tool-result trimming) and immediately useful to see what's bloating context.
      try {
        const trace = (result.toolTrace || []).map((t) => {
          const raw = Math.ceil((t.resultChars || 0) / 4);
          const filtered = Math.ceil((t.filteredChars != null ? t.filteredChars : t.resultChars || 0) / 4);
          return { name: t.name, rawTokens: raw, resultTokens: filtered, saved: Math.max(0, raw - filtered), rules: t.rules || [], truncated: !!t.truncated, isError: t.ok === false };
        });
        if (trace.length) _e.sender.send('chat:progress', { type: 'internals-tools', trace });
      } catch (e) { console.error('[internals tools]', e && e.message); }

      // Telemetry (objective 0): record real usage + reductions for this turn.
      let metricRow = null;
      try {
        const est = estimateTokens(convo);
        const filterSaved = (result.toolTrace || []).reduce((n, t) => {
          const raw = t.resultChars || 0; const after = t.filteredChars != null ? t.filteredChars : raw;
          return n + Math.max(0, raw - after) / 4;
        }, 0);
        const compactionSaved = compressed ? Math.max(0, estimateTokens(base) - est) : 0;
        const u = result.usage || {};
        metricRow = {
          projectId: projectId || null, chatId: payload?.chatId || null, model: chosenModel,
          measured: !!u.measured,
          inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, cachedTokens: u.cachedTokens || 0, cacheCreationTokens: u.cacheCreationTokens || 0,
          estInputTokens: est, window: contextWindowFor(chosenModel),
          skillsAvailable: skillSelect ? skillSelect.available : 0,
          skillsLoaded: skillSelect ? (skillSelect.selected || []).length : 0,
          skillSavedTokens: skillSelect ? (skillSelect.savedTokens || 0) : 0,
          skillsUsed: skillSelect ? (skillSelect.selected || []) : [],
          filterSavedTokens: Math.round(filterSaved),
          compactionSavedTokens: compactionSaved,
          delegated: delegatedCount, delegateAbsorbedTokens: delegateAbsorbed
        };
        repo.metrics.record(metricRow);
        _e.sender.send('chat:progress', { type: 'metrics', ...metricRow });
      } catch (e) { console.error('[metrics]', e && e.message); }

      return { model: chosenModel, reply: result.reply, provider: provider.type, toolTrace: result.toolTrace, compressed, usage: result.usage || null };
    }

    return { model: model || 'stub', reply: `(${model || 'stub'} stub) You said: ${text}`, toolTrace: [] };
  });
}

module.exports = { registerIpc };
