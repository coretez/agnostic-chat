'use strict';

const { ipcMain, shell, dialog, BrowserWindow } = require('electron');
const repo = require('./db/repo');
const { getConnector, testConnection, registryList } = require('./providers');
const { connectAndList } = require('./mcp/client');
const mcpManager = require('./mcp/manager');
const { runAuthFlow } = require('./mcp/oauth');
const { runChatLoop } = require('./chat-loop');
const { executePlan, executeStep, synthesize } = require('./execute');
const { reviewChanges } = require('./review');
const { derivePlan, refinePlan } = require('./plan-derive');
const { VariableStore, SET_VARIABLE_TOOL } = require('./variables');
const { enrichSkillRow, parseFrontmatter } = require('./skill-content');
const { runSubagent, mergeResults, DEFAULT_AGENT, DELEGATE_TOOL, ASSIGN_TOOL } = require('./subagent');
const { runEvaluator } = require('./evaluator');
const { selectContext, applyToolCeiling } = require('./context-select');
const { buildCodingTools, buildLibraryTools, hasGit, initGit, commitStep } = require('./coding-tools');
const projectDocs = require('./project-docs');
const { updateDocs } = require('./doc-writer');
const webTools = require('./web-tools');
const projectFacts = require('./project-facts');

// O7: render the alignment outcome — the reply IS the open decisions. Plain
// markdown the renderer already knows how to display.
function renderAlignReply(plan) {
  const parts = [];
  parts.push('Before building, a few directions need your call' + (plan.goal ? ` — goal: **${plan.goal}**` : '') + ':');
  plan.decisions.forEach((d, i) => {
    parts.push(`\n**${i + 1}. ${d.question}**`);
    for (const o of d.options) parts.push(`- ${o}`);
    if (d.recommendation) parts.push(`*Recommendation: ${d.recommendation}*`);
  });
  parts.push('\nReply with your choices (e.g. "1: React Native, 2: internal only") and I will plan the build against them — your decisions are recorded and won\'t be re-asked.');
  return parts.join('\n');
}
const docs = require('./documents');

// Tool the model calls to persist a generated deliverable. It supplies semantic
// metadata; the app derives the on-disk path (placement policy) + indexes it.
const SAVE_DOCUMENT_TOOL = {
  name: 'save_document',
  description:
    "Save a generated deliverable (report, document, export) to the project's document "
    + 'library on disk so the user can find it later. Provide the full content plus '
    + 'metadata: a type (e.g. monthly-report, investigation, compliance-assessment), a '
    + 'title, a format (html|md|txt|json), and properties like tenant/company and '
    + 'period/date. The app files it in a consistent, findable location, versions it, '
    + 'indexes it, and opens it — you get back the path. Prefer this over pasting a long '
    + 'document only into the chat.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Human-readable title, e.g. "Expo NIST Compliance One-Pager".' },
      type: { type: 'string', description: 'Document type, e.g. monthly-report | investigation | compliance-assessment.' },
      format: { type: 'string', description: 'html | md | txt | json.' },
      properties: { type: 'object', description: 'Metadata: tenant/company, period/date, case_id, framework, tags — whatever applies.' },
      content: { type: 'string', description: 'The complete document content.' }
    },
    required: ['title', 'content']
  }
};
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

function buildLedger({ convo, tools, model, compressed, tokensBefore, skillSelect, toolScope }) {
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
  if (skillSelect) {
    events.push({ type: 'skill-select', available: skillSelect.available, selected: (skillSelect.selected || []).length, saved: skillSelect.savedTokens || 0, error: skillSelect.error });
  }
  if (toolScope) {
    events.push({ type: 'tool-scope', totalAvailable: toolScope.totalAvailable, scoped: toolScope.scoped, bySkills: toolScope.bySkills, fellBack: toolScope.fellBack });
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

// Frontmatter reading lives in skill-content.js (shared with read-time skill
// healing); `enrichSkillRow`/`parseFrontmatter` are imported at the top.

// Fluency's real skills_update shape (what parseSkillsPayload above doesn't
// understand): { items: [{ name, files: [{ path: 'SKILL.md', content }] }] }.
// content is a SKILL.md with YAML frontmatter — description and mcp_functions
// live there. Extracting mcp_functions here is what makes dynamic tool binding
// (skills.tools_json) populate automatically on import instead of requiring
// per-skill manual authoring. toolPrefix is the same `<server>__` namespace
// buildToolset() uses, so the produced names match real tool names exactly.
function parseFluencySkillItems(text, toolPrefix) {
  let data; try { data = JSON.parse(text); } catch { return []; }
  const items = data && Array.isArray(data.items) ? data.items : null;
  if (!items) return [];
  const out = [];
  for (const item of items) {
    const files = Array.isArray(item.files) ? item.files : [];
    const file = files.find((f) => /SKILL\.md$/i.test(f.path || '')) || files[0];
    if (!file || typeof file.content !== 'string') continue;
    const { meta } = parseFrontmatter(file.content);
    const name = item.name || meta.name;
    if (!name) continue;
    const fns = Array.isArray(meta.mcp_functions) ? meta.mcp_functions : [];
    const entry = {
      name,
      description: meta.description || null,
      definition: file.content // full SKILL.md (frontmatter + body) — self-documenting
    };
    // Omit `tools` entirely (leave undefined) when this skill's frontmatter
    // doesn't declare mcp_functions — upsertByName treats undefined as "no
    // signal, don't touch," so a skill with no declared functions doesn't
    // silently wipe a tool scope someone configured by hand in the UI.
    if (fns.length && toolPrefix) entry.tools = fns.map((fn) => `${toolPrefix}__${fn}`);
    out.push(entry);
  }
  return out;
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

// Like parseSkillNames, but keeps the server's declared version for each
// skill — the raw material for drift detection (mcp:checkSync).
function parseSkillVersions(text) {
  if (!text) return {};
  let d = null; try { d = JSON.parse(text); } catch {}
  if (!d) return {};
  const buckets = [];
  const sk = d.skills;
  if (sk && Array.isArray(sk.items)) buckets.push(sk.items);
  else if (sk && Array.isArray(sk.list)) buckets.push(sk.list);
  else if (Array.isArray(sk)) buckets.push(sk);
  if (Array.isArray(d.items)) buckets.push(d.items);
  const out = {};
  for (const arr of buckets) for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const name = o.name || o.slug || o.id || o.skill;
    const version = o.version || o.ver || o.skill_version;
    if (name && version) out[name] = String(version);
  }
  return out;
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
  // In-place update (git-checkout mode today; release channel when packaged).
  ipcMain.handle('update:check', async () => {
    try { return await require('./updater').checkForUpdate(); }
    catch (e) { return { available: false, error: e.message }; }
  });
  ipcMain.handle('update:apply', async (e) => {
    try {
      return await require('./updater').applyUpdate((phase) => {
        try { e.sender.send('update:phase', { phase }); } catch {}
      });
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('projects:setPreferredModel', (_e, { id, model }) => repo.projects.setPreferredModel(id, model));
  // Coding-mode git story: report + one-click initialize (deterministic, main-side).
  ipcMain.handle('projects:gitStatus', (_e, { id }) => {
    const p = repo.projects.get(id);
    return { workingDir: (p && p.working_dir) || null, hasGit: !!(p && p.working_dir && hasGit(p.working_dir)) };
  });
  ipcMain.handle('projects:gitInit', (_e, { id }) => {
    const p = repo.projects.get(id);
    if (!p || !p.working_dir) return { ok: false, error: 'No working directory set.' };
    return initGit(p.working_dir);
  });
  ipcMain.handle('projects:setCheatSheet', (_e, { id, text }) => repo.projects.setCheatSheet(id, text));
  ipcMain.handle('projects:setOutputDir', (_e, { id, dir }) => repo.projects.setOutputDir(id, dir));
  // The effective output dir (explicit, or the resolved default) — for display.
  ipcMain.handle('projects:effectiveOutputDir', (_e, { id }) => {
    const p = repo.projects.get(id);
    const base = repo.settings.get('documents_base') || docs.defaultBase();
    return { outputDir: docs.resolveOutputDir(p, base), explicit: !!(p && p.output_dir) };
  });
  ipcMain.handle('projects:pickOutputDir', async (_e, { id }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const p = repo.projects.get(id);
    const base = repo.settings.get('documents_base') || docs.defaultBase();
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose where generated documents are saved',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: (p && p.output_dir) || docs.resolveOutputDir(p, base)
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    return { ok: true, project: repo.projects.setOutputDir(id, res.filePaths[0]) };
  });
  ipcMain.handle('documents:remove', (_e, { id }) => repo.documents.remove(id));
  // Attachments are written to disk under the project's document library —
  // an upload that exists only as a DB blob cannot be opened by read_file,
  // which made attached files invisible to the very tools meant to use them.
  ipcMain.handle('documents:saveUpload', (_e, { projectId, name, content }) => {
    const p = repo.projects.get(projectId);
    if (!p) return { error: 'project not found' };
    const base = repo.settings.get('documents_base') || docs.defaultBase();
    const outDir = docs.resolveOutputDir(p, base);
    const safe = String(name || 'upload').replace(/[/\\]/g, '-').slice(0, 120);
    const abs = require('node:path').join(outDir, 'uploads', safe);
    const w = docs.writeFileVersioned(abs, content || '');
    let row = null;
    try {
      row = repo.documents.saveGenerated({
        projectId, title: safe, path: w.absPath, mimeType: 'text/plain',
        source: 'upload', docType: null, version: w.version
      });
    } catch (e) { console.error('[upload index]', e && e.message); }
    return { id: row && row.id, path: w.absPath, version: w.version };
  });
  // Read a document's content for the library reader (path preferred, inline
  // content as fallback). Read-only; renderer has no fs access of its own.
  ipcMain.handle('documents:read', (_e, { id }) => {
    const d = repo.documents.get(id);
    if (!d) return { error: 'Document not found.' };
    try {
      const fs = require('node:fs');
      if (d.path && fs.existsSync(d.path)) return { content: fs.readFileSync(d.path, 'utf8'), mime: d.mime_type || 'text/plain', title: d.title };
      return { content: d.content || '', mime: d.mime_type || 'text/plain', title: d.title };
    } catch (e) { return { error: e.message }; }
  });
  // Bootstrap the canonical dev-doc set (docs/SPEC.md, DESIGN.md, PSEUDOCODE.md,
  // KNOWLEDGE.md) — idempotent; the renderer calls this when a project opens so
  // the DOCUMENTS tab always shows the project's documentation structure.
  ipcMain.handle('documents:ensureCanonical', (_e, { projectId }) => {
    const p = repo.projects.get(projectId);
    if (!p) return { created: [] };
    const base = repo.settings.get('documents_base') || docs.defaultBase();
    const outDir = docs.resolveOutputDir(p, base);
    const created = projectDocs.ensureCanonicalDocs({ projectId, docsBase: p.working_dir || outDir });
    const backfilled = projectDocs.backfillFiles({ projectId, outputDir: outDir });
    if (backfilled.length) console.log('[docs] wrote', backfilled.length, 'database-only document(s) to disk');
    return { created, backfilled };
  });

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
  ipcMain.handle('chats:setMode', (_e, { id, mode }) => repo.chats.setMode(id, mode));
  // Tracked variables (working memory) — visible and editable by the user.
  ipcMain.handle('chats:variables', (_e, { id }) => {
    try { return VariableStore.fromJSON(repo.chats.getVariables(id)).toJSON(); } catch { return []; }
  });
  ipcMain.handle('chats:setVariable', (_e, { id, key, value }) => {
    const store = VariableStore.fromJSON(repo.chats.getVariables(id));
    // A value the user typed is `user` confidence: it outranks anything the
    // model observed and survives contradiction.
    if (value == null || value === '') store.remove ? store.remove(key) : store.set({ key, value: '' }, { confidence: 'user', source: 'user' });
    else store.set({ key, value }, { confidence: 'user', source: 'user' });
    repo.chats.setVariables(id, store.size ? JSON.stringify(store.toJSON()) : null);
    return store.toJSON();
  });
  ipcMain.handle('chats:archive', (_e, { id }) => repo.chats.archive(id));
  ipcMain.handle('messages:list', (_e, { chatId }) => repo.messages.listByChat(chatId));
  ipcMain.handle('messages:add', (_e, input) => repo.messages.add(input));
  ipcMain.handle('messages:rate', (_e, { id, rating }) => repo.messages.setRating(id, rating));

  // Documents (project-scoped) + chat links
  // DOCUMENT TARGETS (Overview form): list the project's installed format
  // targets + which is active, and install a new one (file picker → copied
  // into the library's formats/ folder → selected).
  const resolveProjectOutputDir = (projectId) => {
    const project = repo.projects.get(projectId);
    return docs.resolveOutputDir(project, repo.settings.get('documents_base') || docs.defaultBase());
  };
  ipcMain.handle('documents:listFormats', (_e, { projectId }) => {
    const fsx = require('node:fs'); const px = require('node:path');
    const outputDir = resolveProjectOutputDir(projectId);
    let formats = [];
    try { formats = fsx.readdirSync(px.join(outputDir, 'formats')).filter((f) => f.toLowerCase().endsWith('.html')); } catch {}
    const explicit = String(repo.settings.get('output_format', projectId) || '').trim();
    const active = explicit ? px.basename(explicit) : (formats.length === 1 ? formats[0] : '');
    return { formats, active, explicit: !!explicit, dir: px.join(outputDir, 'formats') };
  });
  ipcMain.handle('documents:installFormat', async (e, { projectId }) => {
    const fsx = require('node:fs'); const px = require('node:path');
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a sample document (html) to use as the format target',
      filters: [{ name: 'HTML documents', extensions: ['html', 'htm'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const outputDir = resolveProjectOutputDir(projectId);
    const dir = px.join(outputDir, 'formats');
    fsx.mkdirSync(dir, { recursive: true });
    const name = px.basename(res.filePaths[0]);
    fsx.copyFileSync(res.filePaths[0], px.join(dir, name));
    repo.settings.set('output_format', px.join('formats', name), projectId);
    return { installed: name };
  });
  // O24 first slice: deterministic html → pdf conversion of an INDEXED
  // library document (id, not a raw path — the index is the containment).
  // The pdf is indexed beside its source with the same title and docType.
  ipcMain.handle('documents:toPdf', async (_e, { id }) => {
    const row = repo.documents.get(id);
    if (!row || !row.path) throw new Error(`no document with id ${id}`);
    const { htmlToPdf } = require('./render-pdf');
    const out = await htmlToPdf(row.path);
    let indexed = null;
    try {
      indexed = repo.documents.saveGenerated({
        projectId: row.project_id, title: row.title, path: out.pdfPath, mimeType: 'application/pdf',
        source: 'convert', docType: row.doc_type || null, version: 1,
        properties: typeof row.properties === 'string' ? JSON.parse(row.properties) : (row.properties || null)
      });
    } catch (e) { console.error('[toPdf index]', e && e.message); }
    return { pdfPath: out.pdfPath, bytes: out.bytes, id: indexed && indexed.id };
  });
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
    // Same `<server>__` namespace buildToolset() uses — needed so mcp_functions
    // parsed out of each skill's frontmatter become real, matchable tool names.
    const suServerId = (ts.routes.get(su.name) || {}).serverId;
    const suServer = suServerId ? repo.mcp.get(suServerId) : null;
    const toolPrefix = suServer ? mcpManager.sanitize(suServer.name) : null;

    // 1) Get the list of available skills (small) via version_check.
    emit({ phase: 'list' });
    let names = [];
    if (vc) {
      try {
        const r = await mcpManager.callTool(vc.name, { client: 'claude' }, ts.routes);
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
          const fluencyParsed = parseFluencySkillItems(r.text, toolPrefix);
          const use = fluencyParsed.length ? fluencyParsed : parseSkillsPayload(r.text);
          for (const s of use) { const nm = s.name || name; repo.skills.upsertByName({ ...s, name: nm }); if (!installed.includes(nm)) installed.push(nm); }
          if (!use.length) installed.push(name), repo.skills.upsertByName({ name, definition: r.text });
        } catch (e) { console.error('[skills import] fetch', name, e && e.message); emit({ phase: 'error', name, error: e.message }); }
      }
    } else {
      // Fallback: no parseable list — pull the bundle once (main-side parse; never hits the model).
      emit({ phase: 'bulk' });
      try {
        const r = await mcpManager.callTool(su.name, { client: 'claude' }, ts.routes);
        const fluencyParsed = parseFluencySkillItems(r.text, toolPrefix);
        const parsed = fluencyParsed.length ? fluencyParsed : parseSkillsPayload(r.text);
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
  // Per-project MCP scoping (opt-out, mirrors skills:enabledForProject)
  ipcMain.handle('mcp:enabledForProject', (_e, { projectId }) => repo.mcp.listEnabledForProject(projectId));
  ipcMain.handle('mcp:setForProject', (_e, input) => repo.mcp.setForProject(input));

  // Connect to an MCP server and list its tools. Accepts { id } (saved — uses
  // stored/OAuth token, caches the connection) or an ephemeral config.
  // Version drift (2026-08-09): imported skills and cached tool listings are
  // SNAPSHOTS of a server that keeps moving. Compare the live server against
  // what the app is actually using and report — the renderer badges it and
  // offers a one-click refresh (mcp:connect re-caches tools; then
  // skills:importFromMcp re-imports skills). Never silently out of sync.
  ipcMain.handle('mcp:checkSync', async (_e, { serverId } = {}) => {
    let ts;
    try { ts = await mcpManager.buildToolset(); } catch (e) { return { ok: false, error: e.message }; }
    const servers = repo.mcp.list().filter((s) => s.enabled && (!serverId || s.id === serverId));
    const localSkills = repo.skills.list();
    const out = [];
    for (const s of servers) {
      const prefix = mcpManager.sanitize(s.name) + '__';
      const live = ts.tools.filter((t) => (ts.routes.get(t.name) || {}).serverId === s.id).map((t) => t.name.replace(prefix, '')).sort();
      if (!live.length) continue;   // not connected this pass — nothing to compare
      const cached = (s.tools || []).map((t) => t.name).sort();
      const toolsAdded = live.filter((t) => !cached.includes(t));
      const toolsRemoved = cached.filter((t) => !live.includes(t));
      const skillsOutdated = [];
      const vc = ts.tools.find((t) => t.name === prefix + 'version_check');
      if (vc) {
        try {
          const r = await mcpManager.callTool(vc.name, { client: 'claude' }, ts.routes);
          const remote = parseSkillVersions(r.text);
          for (const sk of localSkills) {
            const rv = remote[sk.name];
            if (!rv) continue;
            const lv = String((parseFrontmatter(sk.definition || '').meta || {}).version || '');
            if (lv && lv !== rv) skillsOutdated.push({ name: sk.name, local: lv, remote: rv });
          }
        } catch (e) { console.error('[mcp checkSync] version_check', s.name, e && e.message); }
      }
      out.push({
        serverId: s.id, name: s.name,
        toolsAdded: toolsAdded.length, toolsRemoved: toolsRemoved.length,
        skillsOutdated,
        drift: !!(toolsAdded.length || toolsRemoved.length || skillsOutdated.length)
      });
    }
    return { ok: true, servers: out };
  });
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

  // Chat — route to the selected provider connection; requires one to be set.
  ipcMain.handle('chat:send', async (_e, payload) => {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const providerId = payload?.providerId;
    const model = payload?.model;
    const messages = Array.isArray(payload?.messages) && payload.messages.length
      ? payload.messages
      : [{ role: 'user', content: text }];

    // Files attached to this message. The planner is given their real paths —
    // without this it plans against the typed sentence alone and asks the user
    // for files they already sent.
    const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
    const plannerText = attachments.length
      ? text + '\n\nFILES ATTACHED TO THIS MESSAGE — already saved in the project. Read them with read_file at these exact paths; do NOT ask the user where they are:\n'
        + attachments.map((a) => `- ${a.path || a.name}${a.chars ? ` (${a.chars} chars)` : ''}`).join('\n')
      : text;

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
      const turnStart = Date.now();
      const chatId = payload?.chatId || null;
      const taskLog = []; // per-task timing/tokens (sub-agents; tools added post-loop)

      // STOP support (abort + save work): the renderer's STOP button fires
      // chat:abort. The signal kills the in-flight provider HTTP call, and
      // every loop checks isAborted() at its next boundary — variables,
      // step results, tool trace, and metrics are all still persisted.
      let aborted = false;
      const turnAbort = new AbortController();
      const abortListener = () => { aborted = true; try { turnAbort.abort(); } catch {} emitProgress({ type: 'process', kind: 'abort' }); };
      ipcMain.once('chat:abort', abortListener);
      const isAborted = () => aborted;
      const chatAbortable = (a) => connector.chat({ ...a, signal: turnAbort.signal });

      // One-shot user prompts (limit / stuck / action-approve): emit an event,
      // await the reply on chat:continue. Waiters are a FIFO queue — parallel
      // sub-agents can each be awaiting an approval, and a single shared slot
      // would resolve the wrong waiter (the loser hanging to its timeout).
      // No reply in 180s, or a STOP, resolves 0.
      const promptWaiters = [];
      const promptListener = (_ev, payload) => { const w = promptWaiters.shift(); if (w) w(Number(payload && payload.more) || 0); };
      ipcMain.on('chat:continue', promptListener);
      const askUser = (event) => new Promise((resolve) => {
        let done = false;
        const finish = (n) => {
          if (done) return; done = true;
          const i = promptWaiters.indexOf(finish); if (i >= 0) promptWaiters.splice(i, 1);
          clearTimeout(to); clearInterval(iv); resolve(n);
        };
        promptWaiters.push(finish);
        const to = setTimeout(() => finish(0), 180000);
        const iv = setInterval(() => { if (isAborted()) finish(0); }, 500);
        emitProgress(event);
      });

      const projectId = payload?.projectId;

      // Gather tools from enabled MCP servers (skips any that fail to connect).
      // Project-scoped: a project_mcp row with enabled=0 keeps that server's
      // whole catalog out of this project's turns (opt-out, like skills).
      // Done before skill handling — the unified context planner below needs
      // both the skill menu and the tool menu at once.
      let toolset = { tools: [], routes: new Map() };
      try { toolset = await mcpManager.buildToolset(projectId); } catch (e) { console.error('[mcp] buildToolset', e && e.message); }

      // Skills: enabled = candidate. Tools: gathered above. ONE planning call
      // (context-select.js) decides both which skills to load in full and
      // which tools to expose for this turn — always run, not gated on size;
      // gating on thresholds was exactly what let a turn's fixed overhead
      // (skills + tool schemas) balloon past what a request actually needed.
      let base = messages;
      let skillSelect = null;
      let loadedSkills = []; // skills actually in scope this turn — drives the tool ceiling below
      let es = [];
      if (projectId) {
        try { es = repo.skills.listEnabledForProject(projectId); } catch (e) { console.error('[skills]', e && e.message); }
        // Read-time healing (skill-content.js): rows imported before the
        // Fluency envelope parser existed hold the raw delivery JSON and a
        // NULL description — extract the embedded SKILL.md body, frontmatter
        // description, and declared mcp_functions so selection, planning and
        // injection all see real instructions regardless of import vintage.
        try {
          const toolNames = toolset.tools.map((t) => t.name);
          es = es.map((s) => enrichSkillRow(s, toolNames));
        } catch (e) { console.error('[skills enrich]', e && e.message); }
      }

      let planned = { skillNames: [], toolNames: [] };
      try {
        planned = await selectContext({ connector: { chat: chatAbortable }, model: fastModel, skills: es, tools: toolset.tools, userText: plannerText });
        // A soft failure (unparseable JSON, etc.) is returned, not thrown — log
        // it here so it's visible in real time, not just reverse-engineered
        // later from a suspicious "0 skills loaded" turn.
        if (planned.error) console.warn('[context-select]', planned.error);
        if (planned.skillMismatch) console.warn('[context-select] mismatch —', planned.skillMismatch);
        if (planned.toolMismatch) console.warn('[context-select] mismatch —', planned.toolMismatch);
      } catch (e) {
        console.error('[context-select]', e && e.message);
        planned = { skillNames: [], toolNames: [], error: e.message };
      }

      if (es.length) {
        try {
          const fullTokens = estimateTokens(es.map((s) => ({ content: s.definition || s.description || '' })));
          const chosenNames = new Set(planned.skillNames.map((n) => n.toLowerCase()));
          const toLoad = es.filter((s) => chosenNames.has(s.name.toLowerCase()));
          const menu = es.map((s) => `- ${s.name}: ${String(s.description || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
          const loaded = toLoad.map((s) => `## ${s.name}\n${s.definition || s.description || ''}`).join('\n\n');
          const loadedTokens = estimateTokens(toLoad.map((s) => ({ content: s.definition || s.description || '' })));
          skillSelect = { available: es.length, selected: toLoad.map((s) => s.name), fullTokens, loadedTokens, savedTokens: Math.max(0, fullTokens - loadedTokens), error: planned.error || planned.skillMismatch };
          const sys = 'Project skills — you can use these. Menu (name — when to use):\n' + menu
            + (loaded ? '\n\nInstructions loaded for this turn:\n\n' + loaded
                      : '\n\n(No skill instructions loaded this turn. If one of the above is needed, say so.)');
          base = [{ role: 'system', content: sys }, ...messages];
          emitProgress({ type: 'process', kind: 'skill-select', available: skillSelect.available, selected: skillSelect.selected, savedTokens: skillSelect.savedTokens });
          loadedSkills = toLoad;
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

      // Tool ceiling: enforce any declared skill tool scope over the planner's
      // picks (context-select.js's applyToolCeiling — a hard restriction the
      // operator authored on a skill, not just a relevance hint). Falls back
      // to the full catalog (not an arbitrary slice) if planning produced no
      // usable picks at all.
      let scopedTools = toolset.tools;
      let toolScope = null;
      if (toolset.tools.length) {
        const ceiling = applyToolCeiling({ loadedSkills, toolNames: planned.toolNames, allTools: toolset.tools });
        scopedTools = ceiling.tools;
        toolScope = { totalAvailable: toolset.tools.length, scoped: scopedTools.length, bySkills: ceiling.bySkills, fellBack: ceiling.fellBack };
        if (ceiling.fellBack) console.warn('[context-select] no usable tool picks — falling back to the full catalog' + (planned.error ? ` (${planned.error})` : ''));
        emitProgress({ type: 'process', kind: 'tool-scope', totalAvailable: toolScope.totalAvailable, scoped: toolScope.scoped, bySkills: toolScope.bySkills, fellBack: toolScope.fellBack });
      }

      // ── Chat mode (per-chat, titlebar): WORK · DOCUMENTS · CODE ──────────
      // WORK — the general agentic harness (MCP tools + skills + planning);
      //   no extra directives, today's default behavior.
      // DOCUMENTS — same capabilities, but the deliverable contract is saved
      //   documents in the library (save_document), not chat prose. No
      //   file/shell tools.
      // CODE — the coding harness: file + shell tools with the HIERARCHICAL
      //   permission model (coding-tools.js):
      //   1. Scope (hard jail): file actions stay inside working_dir ∪ docs dir.
      //   2. Action gating: reads free; writes/edits/shell each ask the user
      //      over the same one-shot chat:continue channel as limit/stuck.
      //   3. Bypass: the project's coding_bypass setting skips the asking —
      //      honored ONLY when working_dir is a git repo (rollback exists).
      // Coding tools are appended to scopedTools AFTER the ceiling so the
      // planner derives steps with them, the executor can call them, and
      // sub-agents inherit them — they are the point of the mode, never
      // subject to relevance selection.
      const project = projectId ? repo.projects.get(projectId) : null;
      const chatRow = chatId ? repo.chats.get(chatId) : null;
      const chatMode = (chatRow && (chatRow.mode || (chatRow.coding_mode ? 'code' : ''))) || 'work';
      const globalBase = repo.settings.get('documents_base') || docs.defaultBase();
      const outputDir = docs.resolveOutputDir(project, globalBase);
      // Canonical docs live WITH the code when a working dir exists — in the
      // repo (git-versioned, visible to the agent's own file tools and to any
      // repo analysis), else in the document library.
      const docsBase = (project && project.working_dir) || outputDir;
      let coding = null;
      let library = null;
      let formatTarget = '';
      let branding = '';
      let rawData = false;
      if (chatMode === 'documents') {
        // The documents harness (O20/O22), built on the coding-harness
        // pattern: a jailed tool pack + a mode note + planner rules. Hands
        // differ — read-only, jailed to the LIBRARY; no shell; publication
        // goes through save_document (versioned, indexed, placed).
        library = buildLibraryTools({ root: outputDir });
        // Web tools join the planning menu like coding mode — collection is
        // research, and the planner must see the collection tools to plan it.
        scopedTools = [...scopedTools, ...library.tools, ...webTools.WEB_TOOLS];
        // O24: the project's OUTPUT FORMAT TARGET — a sample document whose
        // visual system every deliverable must reproduce (branding lives in
        // the format, sections in the skill/task). Explicit per-project
        // setting wins; else a single .html in the library's formats/ folder
        // is the target. A SYSTEM capability, not a skill's.
        try {
          const fsx = require('node:fs'); const px = require('node:path');
          const set = String(repo.settings.get('output_format', projectId) || '').trim();
          if (set) formatTarget = set;
          else {
            const fl = fsx.readdirSync(px.join(outputDir, 'formats')).filter((f) => f.toLowerCase().endsWith('.html'));
            if (fl.length === 1) formatTarget = px.join('formats', fl[0]);
          }
        } catch {}
        // The other two DOCUMENT TARGETS (Overview form ↔ chat, either fills
        // them): branding text applied on top of the format, and the
        // raw-data checkbox that adds an Excel export beside each report.
        try { branding = String(repo.settings.get('output_branding', projectId) || '').trim(); } catch {}
        try { rawData = repo.settings.get('output_rawdata', projectId) === '1'; } catch {}
        convo = [{
          role: 'system',
          content: 'DOCUMENTS MODE: the deliverable of this chat is documents, not chat prose. '
            + 'Produce or update documents with the save_document tool — reports, briefs, specs, analyses, exports — '
            + 'which saves into the project document library, versioned and filed. A substantial answer should land '
            + 'as a saved document, with the chat reply a short summary that names the saved file. '
            + 'The document library is at ' + outputDir + ' — read_file, list_dir, and grep_files are jailed to it, '
            + 'so you can read and build on every document already there. When the user iterates on a document, '
            + 'save the revision under the same title and type (versioning is automatic) rather than creating a '
            + 'near-duplicate or pasting long content into chat. Use the research tools to collect material before '
            + 'writing, and keep track of which source supports each claim.'
            + (formatTarget
              ? '\n\nOUTPUT FORMAT TARGET: "' + formatTarget + '" in the document library is the visual standard for '
                + 'every document you produce. Read it with read_file BEFORE composing, and reproduce its fonts, '
                + 'masthead, header block, numbered section headings, tables, chart styling, callouts, spacing, and '
                + 'print rules EXACTLY — replacing the sample content with this turn\'s real content. Branding and '
                + 'layout come from the format target; sections and data come from the task and skill. The format\'s '
                + 'web-font stylesheet links are the only permitted external references; keep every font-family '
                + 'fallback stack so offline rendering degrades gracefully.'
              : '')
            + (branding
              ? '\n\nTARGET DOCUMENT BRANDING (apply to every deliverable, on top of the format): ' + branding
              : '')
            + (rawData
              ? '\n\nRAW DATA EXPORT IS ON: alongside every report, also save the collected tabular data as a '
                + 'spreadsheet — save_document with format "xlsx", type "raw-data", the same title plus " — Data", '
                + 'the same properties, and content as JSON {"sheets":[{"name":"…","rows":[[header…],[values…]]}]} '
                + '(one sheet per dataset; the app renders the Excel file deterministically).'
              : '')
            + ((!formatTarget || !branding)
              ? '\n\nDOCUMENT TARGETS MISSING: '
                + [!formatTarget ? 'Target Document Format' : '', !branding ? 'Target Document Branding' : ''].filter(Boolean).join(' and ')
                + ' is not set for this project. Before producing a document, ask the user for the missing target(s) — '
                + 'they can answer here in chat (state it and it will be recorded to the project) or set it on the '
                + 'project OVERVIEW page under DOCUMENT TARGETS. Do not silently invent branding or a format.'
              : '')
            + (() => { const l = projectId ? projectDocs.listLibrary(projectId) : ''; return l ? '\n\nPROJECT LIBRARY — documents already saved for this project; read them at these exact paths:\n' + l : ''; })()
        }, ...convo];
        emitProgress({ type: 'process', kind: 'documents-mode', outputDir, tools: library.tools.length, formatTarget, branding: !!branding, rawData });
      }
      if (chatMode === 'code') {
        if (project && project.working_dir) {
          const gitAvailable = hasGit(project.working_dir);
          // Live re-check: the user can initialize git MID-TURN from the
          // approval prompt — the very next gate decision must honor it.
          const gitNow = () => hasGit(project.working_dir);
          const approveAction = async ({ kind, summary }) => {
            // The gate prices IRREVERSIBILITY. File writes inside a git
            // working tree are reversible (step-commits record them, git can
            // revert them) — asking per file doesn't scale to real projects,
            // so writes flow freely when git exists. Shell can do things git
            // cannot undo, so it still asks. No git → everything asks.
            if (kind === 'write' && gitNow()) return true;
            // Level-3 bypass (covers shell too): only honored with git — even
            // if the setting was somehow set without it, we still ask.
            try { if (gitNow() && repo.settings.get('coding_bypass', projectId) === '1') return true; } catch {}
            return (await askUser({ type: 'action-approve', kind, summary, gitAvailable: gitNow() })) > 0;
          };
          // Project build environment (Overview → BUILD ENVIRONMENT): KEY=VALUE
          // lines merged into every command and server the model runs, so
          // builds get what they need without inheriting the app's secrets.
          let buildEnv = {};
          try {
            for (const line of String(repo.settings.get('build_env', projectId) || '').split('\n')) {
              const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
              if (m) buildEnv[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
            }
          } catch {}
          coding = buildCodingTools({ root: project.working_dir, docsRoot: outputDir, approveAction, buildEnv, projectId });
          coding.root = project.working_dir;         // for step-commits (O9)
          coding.gitAvailable = gitAvailable;
          // Web tools join the planning menu in coding mode — docs lookup and
          // error-message searches are part of real development.
          scopedTools = [...scopedTools, ...coding.tools, ...webTools.WEB_TOOLS];
          convo = [{
            role: 'system',
            content: 'CODING MODE: file and shell tools are available. Allowed directories: the project working directory '
              + project.working_dir + ' (relative paths resolve here) and the project documents directory ' + outputDir + '. '
              + 'File actions outside those directories are refused. Reads are free. '
              + (gitAvailable
                ? 'File writes/edits are auto-approved (git provides rollback); shell commands pause for the user to approve. '
                : 'Each write, edit, or shell command pauses for the user to approve (no git repo — no rollback). ')
              + 'If an action is declined, continue without it. Read a file before editing it; edit_file replaces an exact '
              + 'existing string. run_command executes in the working directory and is KILLED when it '
              + 'returns — start long-running processes (dev servers, watchers) with start_server, which '
              + 'keeps them alive across turns; read their output with server_logs.'
              + (Object.keys(buildEnv).length ? ' Build environment variables set for this project: ' + Object.keys(buildEnv).join(', ') + '.' : '')
              + (() => { const l = projectId ? projectDocs.listLibrary(projectId) : ''; return l ? '\n\nPROJECT LIBRARY — documents and uploaded files already saved for this project. Read them at these exact paths; do not ask the user to locate them:\n' + l : ''; })()
          }, ...convo];
          emitProgress({ type: 'process', kind: 'coding-mode', root: project.working_dir, docsRoot: outputDir, tools: coding.tools.length, gitAvailable });
        } else {
          console.warn('[coding-mode] chat has coding mode on but the project has no working_dir — tools not offered');
        }
      }

      // Orchestrator gets the MCP tools PLUS `delegate`; sub-agents get the MCP
      // tools only (no `delegate`) so the tree stays one level deep. Coding
      // tools (no `__` namespace) route to the pack; everything else to MCP.
      const rawCallTool = (name, args) => (coding && coding.names.has(name))
        ? coding.call(name, args)
        : (library && library.names.has(name))
          ? library.call(name, args)
          : webTools.names.has(name)
            ? webTools.call(name, args)
            : mcpManager.callTool(name, args, toolset.routes);

      // Authored per-project agents the orchestrator can delegate to by name.
      let authoredAgents = [];
      try { if (projectId) authoredAgents = repo.agents.listByProject(projectId); } catch (e) { console.error('[agents]', e && e.message); }
      const roster = authoredAgents.length
        ? ` Available named agents for this project: ${authoredAgents.map((a) => `"${a.name}"${a.description ? ` — ${a.description}` : ''}`).join('; ')}. Use "auto" for a general sub-agent.`
        : '';
      const delegateTool = { ...DELEGATE_TOOL, description: DELEGATE_TOOL.description + roster };
      const assignTool = { ...ASSIGN_TOOL, description: ASSIGN_TOOL.description + roster };
      // Web tools ride scopedTools in coding mode; plain chats get them here
      // (execution-only) so internet access exists everywhere without dupes.
      const orchestratorTools = [delegateTool, assignTool, SAVE_DOCUMENT_TOOL, SET_VARIABLE_TOOL, ...((coding || library) ? [] : webTools.WEB_TOOLS), ...scopedTools];

      // Document placement template (user-configurable; global default).
      // `project`/`outputDir` were resolved above (coding-mode block).
      const placementTemplate = repo.settings.get('placement_template') || docs.DEFAULT_TEMPLATE;
      const saveDocument = (args) => {
        // Canonical dev docs (spec/design/pseudocode/knowledge) have a fixed,
        // designed home at docs/<NAME>.md — a documentation step's save goes
        // there and versions, never into the deliverables bin.
        const canonType = String(args.type || '').toLowerCase();
        if (projectId && projectDocs.CANONICAL[canonType]) {
          const w = projectDocs.writeCanonical({ projectId, docsBase, docType: canonType, content: args.content || '', source: 'chat' });
          emitProgress({ type: 'process', kind: 'doc-update', doc: canonType, version: w.version });
          emitProgress({ type: 'document-saved', title: projectDocs.CANONICAL[canonType], path: w.absPath, relPath: w.relPath, version: w.version, mime: 'text/markdown' });
          return { text: `Updated ${w.relPath} (v${w.version}) — the project's canonical ${canonType} document.` };
        }
        // Raw-data export: the model authors DATA (JSON sheets); the
        // framework renders the spreadsheet (spreadsheet.js). Deterministic —
        // a malformed payload is a clear tool error, never a corrupt file.
        let saveFormat = args.format;
        let saveContent = args.content || '';
        if (/^(xlsx?|spreadsheet|excel)$/i.test(String(args.format || ''))) {
          try {
            saveContent = require('./spreadsheet').sheetsToXml(JSON.parse(String(args.content || '')));
            saveFormat = 'xls';
          } catch (e) {
            return { text: `save_document (spreadsheet): content must be JSON {sheets:[{name, rows:[[…]]}]} — ${e.message}`, isError: true };
          }
        }
        const meta = { type: args.type, title: args.title, format: saveFormat, properties: args.properties || {} };
        const w = docs.writeDocument({ outputDir, template: placementTemplate, meta, content: saveContent });
        let row = null;
        try {
          row = repo.documents.saveGenerated({ projectId, title: args.title || w.relPath, path: w.absPath, mimeType: w.mime, source: 'chat', docType: args.type || null, version: w.version, properties: args.properties || null });
        } catch (e) { console.error('[save_document index]', e && e.message); }
        emitProgress({ type: 'document-saved', id: row && row.id, title: args.title, path: w.absPath, relPath: w.relPath, version: w.version, mime: w.mime });
        return { text: `Saved "${args.title}" → ${w.relPath} (v${w.version}) in the document library. Full path: ${w.absPath}` };
      };

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
          : scopedTools;
        return { agent, model: (authored && authored.model) || chosenModel, tools: subTools };
      };
      const runOne = async (wanted, task) => {
        const { agent, model: m, tools: subTools } = resolveDelegate(wanted);
        return runSubagent({ connector, model: m, fastModel, agent, task: task || '', tools: subTools, callTool: rawCallTool, onEvent: emitProgress });
      };

      // Variable store — working memory of discovered tool parameters, loaded
      // from the chat and saved back after the turn. Captures happen in BOTH
      // paths: the step executor does its own, and the flat loop's are handled
      // by the callTool wrapper below.
      let store = new VariableStore();
      try { if (chatId) store = VariableStore.fromJSON(repo.chats.getVariables(chatId)); } catch (e) { console.error('[variables load]', e && e.message); }
      const varsAtStart = store.size;

      let delegatedCount = 0, delegateAbsorbed = 0; // telemetry: isolation via sub-agents
      const callTool = async (name, args) => {
        if (name === 'set_variable') {
          // Explicit working-memory write — never routed to MCP.
          const entry = store.set({ key: args && args.key, value: args && args.value, type: args && args.type }, { confidence: 'derived', source: 'set_variable' });
          return { text: entry ? `Remembered ${entry.key} = ${JSON.stringify(entry.value)}` : 'Ignored (empty key or value).' };
        }
        if (name === 'save_document') {
          try { return saveDocument(args || {}); }
          catch (e) { console.error('[save_document]', e && e.message); return { text: `save_document failed: ${e.message}`, isError: true }; }
        }
        if (name === 'delegate') {
          const r = await runOne(args && args.agent, args && args.task);
          delegatedCount += 1; delegateAbsorbed += r.inputTokens || 0;
          taskLog.push({ kind: 'subagent', label: (args && args.agent && args.agent !== 'auto') ? args.agent : 'general', tokens: r.inputTokens || r.conclusionTokens || 0, durationMs: r.durationMs, ok: true });
          return { text: r.conclusion || '(sub-agent returned no conclusion)' };
        }
        if (name === 'assign') {
          // Assign work in parallel, then merge the results.
          const tasks = Array.isArray(args && args.tasks) ? args.tasks.filter((t) => t && t.task) : [];
          if (!tasks.length) return { text: 'assign: no tasks provided', isError: true };
          const results = await Promise.all(tasks.map(async (t) => {
            const r = await runOne(t.agent, t.task);
            delegatedCount += 1; delegateAbsorbed += r.inputTokens || 0;
            taskLog.push({ kind: 'subagent', label: (t.agent && t.agent !== 'auto') ? t.agent : String(t.task || '').slice(0, 60), tokens: r.inputTokens || r.conclusionTokens || 0, durationMs: r.durationMs, ok: true });
            return { agent: (resolveDelegate(t.agent).agent.name), task: t.task, conclusion: r.conclusion || '' };
          }));
          if (args && args.merge) {
            const merged = await mergeResults({ connector, model: chosenModel, instruction: args.merge, results, onEvent: emitProgress });
            return { text: merged || '(merge produced nothing)' };
          }
          return { text: results.map((r, i) => `### Result ${i + 1} — ${r.agent}\n${r.conclusion}`).join('\n\n') };
        }
        // Auto-capture working memory around real MCP calls (id/locator-shaped
        // params only; re-observation is a no-op so the planned path's own
        // captures don't double up).
        try { store.captureFromArgs(args, { source: name }); } catch {}
        const out = await rawCallTool(name, args);
        try { if (!out.isError) store.captureFromResult(name, out.text || ''); } catch {}
        // Coding-mode common variables (dev server URL/port, build/test/lint
        // commands, package manager) — the same durable-facts treatment MCP
        // ids get, so the next turn never re-derives how to run this project.
        try {
          for (const key of projectFacts.capture(store, { name, args, text: out.text || '', ok: !out.isError })) {
            emitProgress({ type: 'process', kind: 'var-capture', key, from: 'project' });
          }
        } catch {}
        return out;
      };

      // Emit the pre-call context ledger so the INTERNALS tab can show exactly
      // what is occupying the window this turn (occupancy, compaction, prompt).
      try {
        const tokensBefore = estimateTokens(base);
        _e.sender.send('chat:progress', buildLedger({ convo, tools: orchestratorTools, model: chosenModel, compressed, tokensBefore, skillSelect, toolScope }));
      } catch (e) { console.error('[internals ledger]', e && e.message); }

      // Interactive continuation: when the loop hits its tool-call budget, ask
      // the renderer (Continue / Stop) via the shared one-shot prompt queue.
      const onLimit = ({ iterations }) => askUser({ type: 'limit', iterations });

      let result;
      let planInfo = null; // {steps, replans, completed} — planner telemetry (v15)
      try {
        // ── Plan Pass 2 (plan-derive.js): derive the steps from the loaded
        // skills + tools + known values. Only attempted when real capabilities
        // are in play; any planner failure degrades to {simple:true}, so the
        // flat loop below remains the worst case — planning can never make a
        // turn worse than today's behavior.
        let plan = null;
        // O15: the canonical project docs (spec/design/pseudocode/knowledge)
        // are the planner's source of truth for objective and purpose —
        // bootstrapped if missing (heals older projects), loaded here,
        // injected into every derive/refine call.
        let docsBlock = '';
        try {
          if (projectId) {
            projectDocs.ensureCanonicalDocs({ projectId, docsBase });
            projectDocs.backfillFiles({ projectId, outputDir });
            docsBlock = projectDocs.load(projectId);
            // The DOCUMENTS tab lists the library; the model needs the same
            // list with real paths, or it hunts for files the user can see.
            const lib = projectDocs.listLibrary(projectId);
            if (lib) docsBlock += (docsBlock ? '\n\n' : '') + 'PROJECT LIBRARY (files on disk — read them with read_file at these paths; never ask the user where they are):\n' + lib;
          }
        } catch (e) { console.error('[project-docs load]', e && e.message); }

        // Coding mode plans against REAL files: a depth-2 map of the working
        // dir feeds Pass 2 so steps name actual paths instead of guessing.
        let repoMap = '';
        if (coding) { try { repoMap = (await coding.call('list_dir', { depth: 2 })).text || ''; } catch {} }

        // O15 doc maintenance — shared by BOTH execution paths; a turn that
        // mutated files must never end unrecorded and undocumented.
        const maintainDocs = async ({ goal, stepResults, toolTrace }) => {
          try {
            emitProgress({ type: 'process', kind: 'doc-writer', model: fastModel });
            const upd = await updateDocs({
              connector: { chat: chatAbortable }, model: fastModel,
              goal, stepResults, toolTrace, files: await readChanged(toolTrace),
              known: store.render(), current: projectDocs.readCanonical(projectId, docsBase)
            });
            for (const t of ['design', 'pseudocode', 'knowledge']) {
              if (!upd[t]) continue;
              const w = projectDocs.writeCanonical({ projectId, docsBase, docType: t, content: upd[t], source: 'pipeline' });
              emitProgress({ type: 'process', kind: 'doc-update', doc: t, version: w.version });
            }
          } catch (e) { console.error('[doc-writer]', e && e.message); }
        };
        const turnMutated = (trace) => (trace || []).some((t) => t.ok !== false && ['write_file', 'edit_file', 'run_command'].includes(t.name));
        // The files a trace actually changed, with content — evidence for the
        // review pass AND the doc-writer (documenting from step summaries
        // alone produced vague docs; real contents produce real module maps).
        const readChanged = async (trace) => {
          if (!coding) return [];
          const paths = [...new Set((trace || [])
            .filter((t) => t.ok !== false && ['write_file', 'edit_file'].includes(t.name))
            .map((t) => (t.args && t.args.path) || '').filter(Boolean))].slice(0, 6);
          const files = [];
          for (const p of paths) {
            const r = await coding.call('read_file', { path: p });
            if (!r.isError) files.push({ path: p, content: String(r.text || '') });
          }
          return files;
        };
        if (scopedTools.length || loadedSkills.length) {
          // Visible + bounded: planning on a thinking fast-model can take
          // minutes — narrate it (the rail/status shows "deriving plan…"
          // instead of silent bouncing balls), and cap it so a stalled
          // provider degrades to the flat loop instead of hanging the turn.
          emitProgress({ type: 'process', kind: 'planning', model: fastModel });
          const planT0 = Date.now();
          plan = await Promise.race([
            derivePlan({ connector: { chat: chatAbortable }, model: fastModel, userText: plannerText, cheatSheet: project && project.cheat_sheet, loadedSkills, tools: scopedTools, store, agents: authoredAgents, codingMode: !!coding, documentsMode: !!library, projectDocs: docsBlock, repoMap, formatTarget, branding, rawData }),
            new Promise((resolve) => setTimeout(() => resolve({ simple: true, goal: '', steps: [], error: 'planning timed out (240s) — fell back to the flat loop' }), 240000))
          ]);
          if (plan.error) console.warn('[plan-derive]', plan.error);
          emitProgress({ type: 'process', kind: 'planning-done', durationMs: Date.now() - planT0, steps: plan.simple ? 0 : plan.steps.length, error: plan.error });
          taskLog.push({ kind: 'select', label: 'derive-plan', tokens: null, durationMs: Date.now() - planT0, ok: !plan.error });
        }

        // O8: decisions the user stated persist at `user` confidence — they
        // outrank model guesses and survive turns/restarts with the store.
        // O15: the same decisions land in the project SPEC as dated decision
        // records — deterministic bookkeeping, the doc twin of step-commits.
        if (plan && Array.isArray(plan.record) && plan.record.length) {
          for (const rec of plan.record) {
            const e = store.set({ key: rec.key, value: rec.value }, { confidence: 'user', source: 'align' });
            if (e) emitProgress({ type: 'process', kind: 'var-set', key: e.key });
            // Chat ↔ Overview parity: DOCUMENT TARGETS stated in chat land in
            // the SAME per-project settings the Overview form shows. Format
            // values resolve against the library's formats/ files by name.
            try {
              if (projectId && rec.key === 'document_branding') {
                repo.settings.set('output_branding', rec.value, projectId);
                emitProgress({ type: 'process', kind: 'doc-target-set', target: 'branding' });
              } else if (projectId && rec.key === 'document_format') {
                const fsx = require('node:fs'); const px = require('node:path');
                const want = String(rec.value).toLowerCase();
                const fl = fsx.readdirSync(px.join(outputDir, 'formats')).filter((f) => f.toLowerCase().endsWith('.html'));
                const hit = fl.find((f) => f.toLowerCase().includes(want)) || (fl.length === 1 ? fl[0] : null);
                if (hit) {
                  repo.settings.set('output_format', px.join('formats', hit), projectId);
                  emitProgress({ type: 'process', kind: 'doc-target-set', target: 'format', value: hit });
                }
              } else if (projectId && rec.key === 'document_rawdata') {
                repo.settings.set('output_rawdata', /^(1|true|yes|on)$/i.test(String(rec.value)) ? '1' : '0', projectId);
                emitProgress({ type: 'process', kind: 'doc-target-set', target: 'rawdata' });
              }
            } catch (e) { console.error('[doc-target-set]', e && e.message); }
          }
          if (projectId) {
            try {
              const w = projectDocs.appendDecisions({ projectId, docsBase, records: plan.record, goal: plan.goal || '' });
              if (w.added) emitProgress({ type: 'process', kind: 'doc-update', doc: 'spec', version: w.version, added: w.added });
            } catch (e) { console.error('[project-docs spec]', e && e.message); }
          }
        }

        if (plan && plan.align && plan.decisions && plan.decisions.length) {
          // ── O7 alignment gate: direction decisions end the turn ───────────
          // No steps run, no synthesis call — the open decisions ARE the
          // reply, and the user's answers arrive as the next turn. The
          // structured decisions also go to the renderer so it can present
          // them as an interactive form (options + write-in); the markdown
          // reply below stays the durable/persisted record.
          emitProgress({ type: 'align-form', goal: plan.goal || '', decisions: plan.decisions });
          emitProgress({ type: 'process', kind: 'align', decisions: plan.decisions.length });
          emitProgress({ type: 'done' });
          result = {
            reply: renderAlignReply(plan), toolTrace: [], iterations: 0,
            usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0, measured: false },
            planned: false, aligned: true
          };
          planInfo = { steps: 0, replans: 0, completed: true };
        } else if (plan && !plan.simple && plan.steps.length > 1) {
          // ── Plan-and-execute path ─────────────────────────────────────────
          emitProgress({ type: 'process', kind: 'plan', goal: plan.goal, merge: plan.merge || '', orchestrator: plan.orchestrator || null, steps: plan.steps.map((s) => ({ id: s.id, task: s.task, produces: s.produces || '', parallel: s.parallel, group: s.group || '' })) });
          const planDeps = { connector: { chat: chatAbortable }, model: fastModel, userText: plannerText, cheatSheet: project && project.cheat_sheet, loadedSkills, tools: scopedTools, agents: authoredAgents, projectDocs: docsBlock, repoMap, formatTarget, branding, rawData };

          // Stuck escalation (decision #1): after the re-plan budget is spent,
          // explain what's stuck via the shared one-shot prompt queue.
          const onStuck = async ({ goal, stuckStep, values, replans }) =>
            ({ continue: (await askUser({ type: 'stuck', goal, step: stuckStep && stuckStep.task, values, replans })) > 0 });

          const exec = await executePlan({
            chat: chatAbortable,
            callTool,
            model: chosenModel,
            plan,
            isAborted,
            // executeStep adds set_variable itself; don't offer it twice.
            tools: orchestratorTools.filter((t) => t.name !== 'set_variable'),
            store,
            history: convo,
            refinePlan: (i) => refinePlan({ ...planDeps, ...i }),
            onStuck,
            // O9: the plan is the git history — a completed step that mutated
            // the tree commits with its `produces` as the message. Framework
            // bookkeeping (no approval); best-effort; parallel steps pass an
            // empty trace so sub-agent work is never mis-attributed.
            onStepComplete: async (step, stepResult, trace) => {
              if (!coding || !coding.gitAvailable) return;
              const mutated = (trace || []).some((t) => t.ok !== false && (t.name === 'write_file' || t.name === 'edit_file' || t.name === 'run_command'));
              if (!mutated) return;
              const msg = `step ${step.id}: ${String(step.produces || step.task || '').slice(0, 150)}`;
              const out = await commitStep(coding.root, msg);
              if (out.committed) emitProgress({ type: 'process', kind: 'step-commit', step: step.id, message: msg });
            },
            // Between-steps compaction that structurally protects the KNOWN
            // VALUES digest (P3) — discovered parameters survive verbatim.
            compact: async (h) => {
              const out = await maybeCompress({
                messages: h,
                contextWindow: contextWindowFor(chosenModel),
                protect: store.render() || undefined,
                summarize: async (older) => {
                  const r = await connector.chat({ model: fastModel, messages: [{ role: 'user', content: SUMMARY_PROMPT + renderForSummary(older) }], maxTokens: 700 });
                  return r.text || '';
                }
              });
              if (out.compressed) emitProgress({ type: 'process', kind: 'mid-turn-compact', tokensBefore: out.tokensBefore });
              return out.messages;
            },
            // Parallel steps hand off to the decompose-and-merge sibling.
            // A sub-agent gets NO shared history — without the KNOWN VALUES
            // block it cannot resolve parameters the plan names symbolically
            // (seen live: a delegated step told to call describe_fingerprint
            // (fingerprint_hash) had no fingerprint_hash and returned thin
            // text with 0 tool calls). Prepend working memory + the step's
            // produces contract to the task.
            // O16: the group merge — ONE bounded fast-model call honoring the
            // plan's orchestrator contract. The executor falls back to
            // concatenation if this throws or returns nothing.
            mergeGroup: async ({ group, results }) => {
              const o = (plan && plan.orchestrator) || {};
              const instruction = [
                o.merge || `Combine the results of the "${group}" tasks into one coherent digest. Preserve every named value (ids, paths, numbers) verbatim; dedupe repeated facts; keep it complete but tight.`,
                o.on_conflict ? `On conflicting findings: ${o.on_conflict}` : ''
              ].filter(Boolean).join('\n');
              emitProgress({ type: 'process', kind: 'group-merge', group, members: results.length, model: fastModel });
              return await mergeResults({
                connector: { chat: chatAbortable }, model: fastModel, instruction,
                results: results.map((r) => ({ agent: 'group', task: r.task, conclusion: r.conclusion })),
                onEvent: emitProgress
              });
            },
            runParallel: async (step) => {
              const known = store.render();
              const task = (known ? known + '\n\n' : '')
                + step.task
                + (step.produces ? `\n\nTHIS TASK MUST PRODUCE: ${step.produces}` : '');
              const r = await runOne(step.agent, task);
              delegatedCount += 1; delegateAbsorbed += r.inputTokens || 0;
              taskLog.push({ kind: 'subagent', label: (step.agent && step.agent !== 'auto') ? step.agent : String(step.task || '').slice(0, 60), tokens: r.inputTokens || r.conclusionTokens || 0, durationMs: r.durationMs, ok: true });
              return { conclusion: r.conclusion || '' };
            },
            onEvent: emitProgress
          });

          // ── O11 verify layer 2+3: quality + security review of the changed
          // files (review.js), deterministic like step-commits. Layer 1 —
          // "it works" — is the plan's own verify step. Confirmed high/med
          // findings get ONE bounded fix step (worst first), then the fix is
          // committed; review can never spiral or break a turn.
          if (coding && !exec.aborted && exec.completed && turnMutated(exec.toolTrace)) {
            try {
              const files = await readChanged(exec.toolTrace);
              if (files.length) {
                emitProgress({ type: 'process', kind: 'review', files: files.length });
                const rev = await reviewChanges({ connector: { chat: chatAbortable }, model: fastModel, files, goal: plan.goal });
                if (rev.findings.length && !isAborted()) {
                  emitProgress({ type: 'process', kind: 'review-findings', count: rev.findings.length });
                  const fixStep = {
                    id: exec.stepResults.length + 1,
                    task: 'Code review found problems in the files you just changed. Fix each one, then re-run the project tests to confirm nothing broke:\n'
                      + rev.findings.map((f) => `- [${f.lens}/${f.severity}] ${f.file}: ${f.issue}${f.fix ? ` — fix: ${f.fix}` : ''}`).join('\n'),
                    produces: 'review findings fixed, tests passing'
                  };
                  const fr = await executeStep({ chat: chatAbortable, callTool, model: chosenModel, step: fixStep, tools: orchestratorTools.filter((t) => t.name !== 'set_variable'), history: exec.history, store, onEvent: emitProgress, isAborted });
                  exec.stepResults.push(fr.result);
                  exec.toolTrace.push(...(fr.toolTrace || []));
                  if (fr.usage && fr.usage.calls) {
                    exec.usage.measured = exec.usage.measured || fr.usage.measured; exec.usage.calls += fr.usage.calls;
                    exec.usage.inputTokens += fr.usage.inputTokens; exec.usage.outputTokens += fr.usage.outputTokens;
                    exec.usage.cachedTokens += fr.usage.cachedTokens; exec.usage.cacheCreationTokens += fr.usage.cacheCreationTokens;
                  }
                  try {
                    const c = await commitStep(project.working_dir, 'review: fix quality/security findings');
                    if (c && c.committed) emitProgress({ type: 'process', kind: 'step-commit', step: 'review' });
                  } catch {}
                  emitProgress({ type: 'process', kind: 'review-fixed', count: rev.findings.length });
                } else if (!rev.findings.length) {
                  emitProgress({ type: 'process', kind: 'review-clean' });
                }
              }
            } catch (e) { console.error('[review]', e && e.message); }
          }

          // The bubble has been streaming per-step text; the synthesis is the
          // REAL reply — tell the renderer to start its buffer fresh so the
          // final message isn't a concatenation of every step's conclusion.
          // On a user STOP there is no synthesis call: assemble the save-work
          // reply from what the steps concluded, with zero further model time.
          let syn;
          if (exec.aborted) {
            const digest = exec.stepResults.map((r) => `### Step ${r.step}: ${r.task}${r.incomplete ? ' (incomplete)' : ''}\n${r.conclusion || '(no result)'}`).join('\n\n');
            emitProgress({ type: 'stream-reset' });
            syn = { reply: '⏹ Stopped at your request — work so far was saved (values remembered, completed steps below).\n\n' + (digest || '(stopped before any step completed)'), usage: null };
          } else {
            emitProgress({ type: 'stream-reset' });
            syn = await synthesize({ chat: chatAbortable, model: chosenModel, plan, stepResults: exec.stepResults, store, history: exec.history, onEvent: emitProgress });
          }
          const u = exec.usage || { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0, measured: false };
          if (syn.usage) {
            u.measured = true; u.calls += 1;
            u.inputTokens += syn.usage.inputTokens || 0; u.outputTokens += syn.usage.outputTokens || 0;
            u.cachedTokens += syn.usage.cachedTokens || 0; u.cacheCreationTokens += syn.usage.cacheCreationTokens || 0;
          }
          emitProgress({ type: 'done' });
          result = { reply: syn.reply, toolTrace: exec.toolTrace, iterations: exec.stepResults.length, usage: u, planned: true, cappedTurn: !exec.completed, aborted: exec.aborted };
          planInfo = { steps: plan.steps.length, replans: exec.replans, completed: exec.completed };

          // O15: documentation is maintained AUTOMATICALLY after execution —
          // a dedicated technical-writer pass (doc-writer.js), deterministic
          // like step-commits and decision records. Plan-step documentation
          // produced untouched skeletons and narrative sludge; this doesn't.
          if (coding && !exec.aborted && projectId && turnMutated(exec.toolTrace)) {
            await maintainDocs({ goal: plan.goal, stepResults: exec.stepResults, toolTrace: exec.toolTrace });
          }
        } else {
          // ── Flat path (unchanged behavior) — with working memory in front of
          // the model so values discovered in earlier turns stay usable.
          const knownBlock = store.render();
          result = await runChatLoop({
            chat: chatAbortable,
            callTool,
            model: chosenModel,
            messages: knownBlock ? [{ role: 'system', content: knownBlock }, ...convo] : convo,
            tools: orchestratorTools,
            onEvent: emitProgress,
            onLimit,
            isAborted
          });
          if (result.aborted && !result.reply) result.reply = '⏹ Stopped at your request — the work above was kept.';

          // A coding turn that fell to the flat loop still gets full
          // bookkeeping: one commit for its mutations + the doc-writer pass.
          // A wandering turn must never be an unrecorded, undocumented turn —
          // and plan_steps=0 in turn_metrics makes the wandering measurable.
          if (coding && !result.aborted && projectId && turnMutated(result.toolTrace)) {
            try {
              const c = await commitStep(project.working_dir, `turn: ${String(text).slice(0, 150)}`);
              if (c && c.committed) emitProgress({ type: 'process', kind: 'step-commit', step: 'turn' });
            } catch (e) { console.error('[flat commit]', e && e.message); }
            await maintainDocs({ goal: text, stepResults: [], toolTrace: result.toolTrace });
          }
        }
      } catch (e) {
        console.error(`[chat] ${provider.type}/${chosenModel} error (${orchestratorTools.length} tools):`, e && e.message);
        throw e;
      } finally {
        ipcMain.removeListener('chat:continue', promptListener);
        ipcMain.removeListener('chat:abort', abortListener);
      }

      // Persist working memory for the next turn (and across restarts).
      try { if (chatId) repo.chats.setVariables(chatId, store.size ? JSON.stringify(store.toJSON()) : null); } catch (e) { console.error('[variables save]', e && e.message); }

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
          delegated: delegatedCount, delegateAbsorbedTokens: delegateAbsorbed,
          durationMs: Date.now() - turnStart,
          // Makes the planner's fallback rate queryable across turns instead
          // of only visible one turn at a time in the INTERNALS tab.
          planningFailed: !!(skillSelect && skillSelect.error),
          toolFellBack: !!(toolScope && toolScope.fellBack),
          // v15: measure the planner itself.
          planSteps: planInfo ? planInfo.steps : 0,
          planRefines: planInfo ? planInfo.replans : 0,
          varsCaptured: Math.max(0, store.size - varsAtStart)
        };
        repo.metrics.record(metricRow);
        // Per-task rows: sub-agents (collected during the loop) + each tool call.
        for (const t of (result.toolTrace || [])) {
          taskLog.push({ kind: 'tool', label: t.name, tokens: Math.ceil((t.filteredChars != null ? t.filteredChars : t.resultChars || 0) / 4), durationMs: t.durationMs, ok: t.ok !== false });
        }
        try { repo.metrics.recordTasks(taskLog.map((t) => ({ ...t, projectId: projectId || null, chatId: payload?.chatId || null }))); } catch (e) { console.error('[task metrics]', e && e.message); }
        const cachePct = metricRow.inputTokens ? Math.round((metricRow.cachedTokens / metricRow.inputTokens) * 100) : 0;
        console.log('[metrics]', JSON.stringify({ measured: metricRow.measured, model: metricRow.model, input: metricRow.inputTokens, output: metricRow.outputTokens, cached: metricRow.cachedTokens, cachePct, est: metricRow.estInputTokens, filterSaved: metricRow.filterSavedTokens, skillSaved: metricRow.skillSavedTokens, delegated: metricRow.delegated, durationMs: metricRow.durationMs, tasks: taskLog.length, planningFailed: metricRow.planningFailed, toolFellBack: metricRow.toolFellBack }));
        _e.sender.send('chat:progress', { type: 'metrics', ...metricRow, tasks: taskLog });
      } catch (e) { console.error('[metrics]', e && e.message); }

      return { model: chosenModel, reply: result.reply, provider: provider.type, toolTrace: result.toolTrace, compressed, usage: result.usage || null, planned: !!result.planned, aborted: !!result.aborted };
    }

    // The renderer should never let a send reach here without a provider (see
    // missingPrereqs() in renderer.js) — no silent stub echo pretending to be a reply.
    throw new Error('No model selected for this chat. Choose a model before sending.');
  });
}

module.exports = { registerIpc };
