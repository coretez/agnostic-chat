'use strict';

const { ipcMain, shell, dialog, BrowserWindow } = require('electron');
const path = require('node:path');
const repo = require('./db/repo');
const { getConnector, testConnection, registryList } = require('./providers');
const { normalizeBaseUrl, testGuard } = require('./guards');
const { connectAndList } = require('./mcp/client');
const mcpManager = require('./mcp/manager');
const { runAuthFlow } = require('./mcp/oauth');
const { runChatLoop } = require('./chat-loop');
const { executePlan, executeStep, synthesize, renderProviderPausedReply, planStatusResults } = require('./execute');
const { reviewChanges } = require('./review');
const { derivePlan, refinePlan } = require('./plan-derive');
const { VariableStore, SET_VARIABLE_TOOL } = require('./variables');
const { enrichSkillRow, parseFrontmatter, skillPreconditions } = require('./skill-content');
const { runSubagent, mergeResults, DEFAULT_AGENT, DELEGATE_TOOL, ASSIGN_TOOL } = require('./subagent');
const { runEvaluator } = require('./evaluator');
const { selectContext, applyToolCeiling } = require('./context-select');
const { TurnToolCache } = require('./turn-tool-cache');
const { buildCodingTools, buildLibraryTools, hasGit, initGit, commitStep, runCheckCommand, didMutate, MUTATING_TOOLS, WRITING_TOOLS } = require('./coding-tools');
const { driftScan } = require('./drift');
const projectDocs = require('./project-docs');
const { updateDocs } = require('./doc-writer');
const webTools = require('./web-tools');
const projectFacts = require('./project-facts');
const devServer = require('./dev-server');
const { ensureStockHost } = require('./workflow-hosting');
const { verifyPrimarySources } = require('./primary-source-verifier');
const librarian = require('./librarian');
const { createWorkflowContract, renderContract, scopeAlignment, constrainPlan, filterMcpToolset, shouldRepairAcceptance, validateWorkflow, renderResumeContext, withResumeContext, resumePlan, focusResumedStockStep, effectiveStepOutputTokenBudget, effectiveStepDurationBudget, effectiveProviderResponseBudget } = require('./workflow-contracts');

// Cost-outlier detection (O14): a turn is flagged when it costs this many
// times the project's recent median input tokens. Needs MIN_HISTORY prior
// measured turns before it says anything, so a new project stays quiet.
const COST_OUTLIER_FACTOR = 3;
const MIN_COST_HISTORY = 5;

// Once a plan has explicit delegated/parallel steps, ad-hoc delegate/assign
// calls inside a sequential step make the run unbounded and unauditable. The
// planner owns delegation in planned mode; step models receive only domain
// tools plus set_variable (injected by executeStep itself).
function toolsForPlannedStep(tools = []) {
  return tools.filter((t) => t && !['set_variable', 'delegate', 'assign'].includes(t.name));
}

function reviewRepairVerified(result, checkRequired, checkState) {
  return !(result && result.incomplete) && (!checkRequired || !!(checkState && checkState.ran && !checkState.failing));
}

function recordDelegatedResult(delegation, taskLog, result, label) {
  delegation.count += 1;
  delegation.absorbedTokens += result.inputTokens || 0;
  taskLog.push({ kind: 'subagent', label, tokens: result.inputTokens || result.conclusionTokens || 0, durationMs: result.durationMs, ok: true });
}

function expandParallelStepTask(step, planSteps) {
  const shorthand = String(step && step.task || '').match(/^same as step\s+(\d+)/i);
  if (!shorthand) return String(step && step.task || '');
  const reference = (planSteps || []).find((candidate) => Number(candidate.id) === Number(shorthand[1]));
  if (!reference) return String(step.task || '');
  const ordinal = String(step.produces || '').match(/investigation_(\d+)/i);
  return ordinal ? String(reference.task || '').replace(/\btop_case_\d+_id\b/g, `top_case_${ordinal[1]}_id`) : String(reference.task || '');
}

function modeFlowSourceContext(contract, repoMap) {
  if (!contract || contract.kind !== 'mode-flow' || !repoMap) return '';
  return `\n\nAUTHORITATIVE SOURCE ROOT FILE MAP — these are application files, separate from the document library. Read relevant source files from these exact paths before drawing conclusions:\n${String(repoMap).slice(0, 12000)}`;
}

function combineAbortSignals(signals = []) {
  const active = signals.filter(Boolean);
  if (active.length < 2) return active[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
  const ctrl = new AbortController();
  for (const signal of active) {
    if (signal.aborted) { ctrl.abort(); break; }
    signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

let mcpAuthBroadcastInstalled = false;

function guardedConnector(provider, providerKey, context = {}) {
  const guard = repo.guards.active();
  if (!guard) return getConnector(provider, providerKey);
  const guardKey = repo.guards.reveal(guard.id);
  if (guard.auth_mode === 'bearer' && !guardKey) throw new Error(`${guard.label || 'The enabled guard'} needs a bearer token.`);
  return getConnector(provider, providerKey, {
    guard, guardKey,
    onAudit: (event) => {
      try { return repo.guards.recordEvent({ guardId: guard.id, providerId: provider.id, ...context, ...event }); }
      catch (error) { console.error('[guard audit]', error && error.message); }
    }
  });
}

/**
 * Confirm an irreversible delete, main-side. Destroy-confirmations belong on
 * the same wall as `coding_bypass` and `check_command`: the renderer asks, the
 * user answers in a dialog the page cannot draw, style, or click for them.
 * Cancel is the default button, so a stray Return keeps the data.
 * @returns {Promise<boolean>} true only on an explicit Delete.
 */
async function confirmDelete({ message, detail }) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Delete permanently', 'Cancel'], defaultId: 1, cancelId: 1,
    message, detail
  });
  return r.response === 0;
}

/** Median of a numeric list, or 0 when there is not enough history to judge. */
function medianOf(values) {
  const v = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (v.length < MIN_COST_HISTORY) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

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

function ledgerTokenBuckets(convo, tools) {
  const buckets = { system: 0, skills: 0, summary: 0, history: 0, current: 0, tools: 0 };
  const nonSystem = convo.filter((message) => message.role !== 'system');
  const current = nonSystem[nonSystem.length - 1];
  for (const message of convo) {
    const bucket = classifyContributor(message);
    buckets[bucket || (message === current ? 'current' : 'history')] += estimateTokens([message]);
  }
  buckets.tools = tools && tools.length ? Math.ceil(JSON.stringify(tools).length / 4) : 0;
  return { buckets, current };
}

function ledgerEvents({ convo, compressed, tokensBefore, skillSelect, toolScope }) {
  const events = [];
  if (skillSelect) events.push({ type: 'skill-select', available: skillSelect.available, selected: (skillSelect.selected || []).length, saved: skillSelect.savedTokens || 0, error: skillSelect.error });
  if (toolScope) events.push({ type: 'tool-scope', totalAvailable: toolScope.totalAvailable, scoped: toolScope.scoped, bySkills: toolScope.bySkills, fellBack: toolScope.fellBack });
  if (compressed) {
    const tokensAfter = estimateTokens(convo);
    events.push({ type: 'compact', tokensBefore, tokensAfter, saved: Math.max(0, tokensBefore - tokensAfter) });
  }
  return events;
}

function assembledLedgerMessages(convo, current) {
  const cap = 20000;
  return convo.map((message) => {
    const content = message.content || ''; const clipped = content.length > cap;
    return {
      role: message.role, contributor: classifyContributor(message) || (message === current ? 'current' : 'history'),
      tokens: estimateTokens([message]), content: clipped ? content.slice(0, cap) : content,
      clippedChars: clipped ? content.length - cap : 0,
      toolCalls: (message.toolCalls || []).map((tool) => tool.name)
    };
  });
}

function buildLedger({ convo, tools, model, compressed, tokensBefore, skillSelect, toolScope }) {
  const { buckets, current } = ledgerTokenBuckets(convo, tools);
  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  const window = contextWindowFor(model);
  const contributors = Object.entries(buckets).filter(([, tokens]) => tokens > 0).map(([key, tokens]) => ({ key, tokens }));
  const events = ledgerEvents({ convo, compressed, tokensBefore, skillSelect, toolScope });
  const assembled = assembledLedgerMessages(convo, current);
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

// ── Documents-surface path containment ──────────────────────────────────────
// Renderer-supplied and DB-indexed paths may only be read/revealed/rendered
// when they lie inside a root the app legitimately manages: the global
// documents base, or a project's output_dir / working_dir. Without this,
// documents:create + documents:read was a two-call arbitrary file read
// (~/.ssh, the DB itself). realpath-based so a symlinked index entry cannot
// point outside; prefix-checked with a trailing separator (no /project vs
// /project-evil confusion).
function documentsRoots() {
  const roots = [];
  try { roots.push(repo.settings.get('documents_base') || docs.defaultBase()); } catch { roots.push(docs.defaultBase()); }
  try {
    for (const p of repo.projects.list({ includeArchived: true }) || []) {
      if (p.output_dir) roots.push(p.output_dir);
      if (p.working_dir) roots.push(p.working_dir);
    }
  } catch {}
  return roots;
}
function realOrNull(p) {
  const fs = require('node:fs');
  try { return fs.realpathSync(p); } catch { return null; }
}
// realpath the deepest EXISTING ancestor and re-append the untraversed tail
// (same rationale as coding-tools.realResolve) — a not-yet-written file under
// /var on macOS must still resolve through the /var→/private/var symlink so
// the prefix check compares real against real.
function realResolveLoose(p) {
  const path = require('node:path');
  let cur = path.resolve(String(p));
  const tail = [];
  for (;;) {
    const real = realOrNull(cur);
    if (real) return tail.length ? path.join(real, ...tail) : real;
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(String(p));
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}
function documentPathAllowed(p) {
  if (!p) return false;
  const path = require('node:path');
  const target = realResolveLoose(p);
  return documentsRoots().some((r) => {
    const rr = realOrNull(r);
    if (!rr) return false;
    return target === rr || target.startsWith(rr + path.sep);
  });
}

// ── Librarian vocabulary (O31) ──────────────────────────────────────────────
// What the project already calls things — existing tags, doc types, entities —
// so filing PREFERS the established vocabulary instead of coining near-
// duplicates. Cheap queries; rebuilt per filing call.
function buildVocabulary(projectId) {
  const v = { tags: [], docTypes: [], entities: [] };
  if (!projectId) return v;
  try { v.tags = repo.tags.listByProject(projectId); } catch {}
  try {
    for (const d of repo.documents.listByProject(projectId)) {
      if (d.doc_type) v.docTypes.push(d.doc_type);
      const ent = d.properties && (d.properties.tenant || d.properties.company);
      if (ent) v.entities.push(String(ent));
    }
  } catch {}
  return v;
}

function registerProjectHandlers() {
  // Projects
  ipcMain.handle('projects:list', (_e, opts) => repo.projects.list(opts));
  ipcMain.handle('projects:create', (_e, input) => repo.projects.create(input));
  ipcMain.handle('projects:rename', (_e, { id, name }) => repo.projects.rename(id, name));
  ipcMain.handle('projects:archive', (_e, { id }) => repo.projects.archive(id));
  ipcMain.handle('projects:unarchive', (_e, { id }) => repo.projects.unarchive(id));
  ipcMain.handle('projects:listArchived', () => repo.projects.listArchived());
  // Deleting a project cascades across chats, messages, documents, tags,
  // agents, settings and credentials. Confirmed main-side with the real
  // counts, and explicit that files on disk are NOT touched.
  ipcMain.handle('projects:delete', async (_e, { id }) => {
    const project = repo.projects.get(id);
    if (!project) return { ok: false, missing: true };
    const c = repo.projects.contents(id);
    const ok = await confirmDelete({
      message: `Permanently delete the project "${project.name}"?`,
      detail: `${c.chats} chat${c.chats === 1 ? '' : 's'}, ${c.messages} message${c.messages === 1 ? '' : 's'} and `
        + `${c.documents} library entr${c.documents === 1 ? 'y' : 'ies'} will be erased. This cannot be undone.\n\n`
        + `The ${c.filesOnDisk} file${c.filesOnDisk === 1 ? '' : 's'} on disk are NOT deleted — they stay where they are, `
        + 'and the app simply stops tracking them.\n\nTo hide the project without losing anything, archive it instead.'
    });
    if (!ok) return { ok: false, cancelled: true };
    repo.projects.remove(id);
    return { ok: true };
  });
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
  // Reveal is jailed to the documents surface — shell.openPath can launch
  // executables via the OS default handler, so an arbitrary path is an
  // execution primitive, not a convenience.
  ipcMain.handle('app:revealPath', (_e, p) => {
    if (!p || !documentPathAllowed(p)) return { ok: false, error: 'path outside the documents library / project directories' };
    shell.openPath(String(p));
    return { ok: true };
  });
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
}

function registerDocumentFileHandlers() {
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
        projectId, title: safe, path: w.absPath, mimeType: docs.mimeForPath(w.absPath),
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
      if (d.path && fs.existsSync(d.path)) {
        // Jail check at READ time — an index row (whatever wrote it) must not
        // become a read primitive for arbitrary files the app can see.
        if (!documentPathAllowed(d.path)) return { error: 'Document path is outside the documents library / project directories.' };
        // A PDF read as utf8 is mojibake — the viewer was showing `%PDF-1.4`
        // and a screenful of replacement characters. Hand the renderer the
        // BYTES so it can let Chromium render the document as a document.
        const isPdf = /pdf/i.test(d.mime_type || '') || /\.pdf$/i.test(d.path);
        if (isPdf) {
          // Hand back the PATH, not the bytes. Chromium refuses a top-level
          // navigation to a data:application/pdf URL (ERR_FAILED — measured),
          // which is what drew the black rectangle. A file: URL renders the
          // document properly. The path is jail-checked directly above, so the
          // renderer only ever receives one inside the allowed roots.
          return { pdfPath: d.path, mime: 'application/pdf', title: d.title, bytes: fs.statSync(d.path).size };
        }
        // Other binaries (spreadsheets, images, archives) have no in-app
        // viewer yet. Say what they are rather than rendering their bytes.
        if (/\.(xlsx?|docx?|pptx?|png|jpe?g|gif|zip|bin)$/i.test(d.path)) {
          return { binary: true, mime: d.mime_type || 'application/octet-stream', title: d.title, path: d.path, bytes: fs.statSync(d.path).size };
        }
        // Resolve against the PATH: an upload is indexed with a hardcoded
        // label regardless of what it is, so trusting mime_type alone showed
        // uploaded .html as source text instead of rendering it.
        return { content: fs.readFileSync(d.path, 'utf8'), mime: docs.mimeForPath(d.path, d.mime_type), title: d.title };
      }
      return { content: d.content || '', mime: docs.mimeForPath(d.path, d.mime_type), title: d.title };
    } catch (e) { return { error: e.message }; }
  });
  // Open a PDF in its own hardened window. Measured 2026-08-14: the artifact
  // <webview> cannot render PDFs (a captured frame held 9 distinct colours —
  // blank), a data:application/pdf URL is refused outright by Chromium
  // (ERR_FAILED), and setting webPreferences.plugins BREAKS the load rather
  // than enabling it. A top-level BrowserWindow on a file: URL renders the
  // document properly (1693 distinct colours in the same measurement), which
  // is what this does. Path is re-jailed here — the renderer passes an id,
  // never a path, so this can never be aimed at an arbitrary file.
  ipcMain.handle('documents:openPdf', (_e, { id }) => {
    const d = repo.documents.get(id);
    if (!d || !d.path) return { error: 'Document not found.' };
    if (!documentPathAllowed(d.path)) return { error: 'Document path is outside the allowed directories.' };
    try {
      const fsx = require('node:fs');
      if (!fsx.existsSync(d.path)) return { error: 'File is missing on disk.' };
      const w = new BrowserWindow({
        width: 900, height: 1100, title: d.title || 'Document',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      });
      // A document window shows a document: no app navigation, no popups.
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.webContents.on('will-navigate', (ev) => ev.preventDefault());
      w.loadURL('file://' + encodeURI(d.path));
      return { ok: true };
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

}

function registerAgentMetricSettingsHandlers() {
  // Agents (authored per-project sub-agent definitions)
  ipcMain.handle('agents:list', (_e, { projectId }) => repo.agents.listByProject(projectId));
  ipcMain.handle('agents:create', (_e, input) => repo.agents.create(input));
  ipcMain.handle('agents:update', (_e, { id, patch }) => repo.agents.update(id, patch));
  ipcMain.handle('agents:remove', (_e, { id }) => repo.agents.remove(id));

  // Turn metrics (telemetry) — read-only for the readout + trend view
  ipcMain.handle('metrics:listByChat', (_e, { chatId }) => repo.metrics.listByChat(chatId));
  ipcMain.handle('metrics:listByProject', (_e, { projectId }) => repo.metrics.listByProject(projectId));
  ipcMain.handle('workflows:latest', (_e, { chatId }) => {
    const run = repo.workflowRuns.latestIncomplete(chatId);
    return run ? { ...run, checkpoints: repo.workflowRuns.checkpoints(run.id) } : null;
  });
  ipcMain.handle('workflows:get', (_e, { runId }) => {
    const run = repo.workflowRuns.get(runId);
    return run ? { ...run, checkpoints: repo.workflowRuns.checkpoints(run.id) } : null;
  });

  // Settings (small key/value store; project_id null = global)
  ipcMain.handle('settings:get', (_e, { key, projectId = null }) => repo.settings.get(key, projectId));
  ipcMain.handle('settings:set', async (_e, { key, value, projectId = null }) => {
    // Enabling the standing bypass is a main-side decision, not a renderer
    // message — a compromised renderer must not be able to silently grant
    // itself unprompted writes (the ipc surface is the second wall).
    if (key === 'coding_bypass' && String(value) === '1') {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['Enable bypass', 'Cancel'], defaultId: 1, cancelId: 1,
        message: 'Run shell commands without asking, for this project?',
        detail: 'File writes already flow without prompts (git rolls them back). This bypass additionally lets SHELL COMMANDS run unprompted — and shell effects (network calls, installs, deletes outside the repo) are NOT undone by git. The BYPASS chip stays visible; click it to revoke.'
      });
      if (r.response !== 0) return { ok: false, cancelled: true };
    }
    // O26 rides the SAME second wall as the bypass: the check command is a
    // renderer-supplied string that main later executes as shell WITHOUT an
    // approval gate (standing consent). That consent must be granted
    // main-side, showing the verbatim command (O5) — a compromised renderer
    // must never be able to install its own unprompted execution.
    if (key === 'check_command' && String(value || '').trim()) {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['Set check command', 'Cancel'], defaultId: 1, cancelId: 1,
        message: 'Run this command automatically for this project?',
        detail: `${String(value).trim()}\n\nThe app will run this WITHOUT asking — at the start of every coding turn and after every change it makes. Only set a command you would run yourself (tests, lint, build).`
      });
      if (r.response !== 0) return { ok: false, cancelled: true };
    }
    return repo.settings.set(key, value, projectId);
  });

  // Meta-evaluator — critique a turn's context engineering with a chosen model.
  ipcMain.handle('evaluate:run', async (_e, { providerId, model, digest }) => {
    const provider = repo.providers.get(providerId);
    if (!provider) return { error: 'Evaluator connection no longer exists.', findings: [] };
    if (!provider.enabled) return { error: `${provider.label || provider.type} is disabled.`, findings: [] };
    const key = repo.providers.reveal(providerId);
    if (!key) return { error: `No API key stored for ${provider.label || provider.type}.`, findings: [] };
    try {
      const connector = guardedConnector(provider, key);
      return await runEvaluator({ connector, model: model || provider.default_model, digest });
    } catch (e) {
      return { error: e && e.message ? e.message : 'evaluation failed', findings: [] };
    }
  });

  // O30: the drift pass — backward-looking garbage collection, user-invoked
  // from the Overview MAINTENANCE card. Read-only scan of recent source files
  // against the rulebook (O29) + canonical docs (O15); findings land in the
  // DEBT ledger (O27). Fixes are NOT applied here — the user runs them as
  // ordinary turns with ordinary gates.
  ipcMain.handle('project:drift', async (_e, { projectId, providerId, model }) => {
    const provider = repo.providers.get(providerId);
    if (!provider || !provider.enabled) return { error: 'No enabled model connection for the drift scan.', findings: [] };
    const key = repo.providers.reveal(providerId);
    if (!key) return { error: `No API key stored for ${provider.label || provider.type}.`, findings: [] };
    const project = repo.projects.get(projectId);
    if (!project || !project.working_dir) return { error: 'The project needs a working directory to scan.', findings: [] };
    try {
      const outputDir = resolveProjectOutputDir(projectId);
      const docsBase = project.working_dir;
      // Read-only pack: the scan uses list_dir/read_file only, so the gate
      // callback can refuse everything without ever being consulted.
      const coding = buildCodingTools({ root: project.working_dir, docsRoot: outputDir, approveAction: async () => false, projectId });
      const rb = projectDocs.readRulebook(project.working_dir);
      const connector = guardedConnector(provider, key);
      const scan = await driftScan({
        connector, model: model || provider.default_model, coding, root: project.working_dir,
        rulebook: rb ? rb.text : '', docsBlock: projectDocs.load(projectId, 4000)
      });
      let debt = { added: 0, repeats: 0 };
      if (scan.findings.length) debt = projectDocs.appendDebt({ projectId, docsBase, findings: scan.findings.map((f) => ({ ...f, status: 'drift scan' })) });
      return { findings: scan.findings, scanned: scan.scanned, added: debt.added, repeats: debt.repeats, error: scan.error };
    } catch (e) {
      return { error: e && e.message ? e.message : 'drift scan failed', findings: [] };
    }
  });

}

function registerChatMessageHandlers() {
  // Chats & messages
  ipcMain.handle('chats:list', (_e, { projectId }) => {
    const rows = repo.chats.listByProject(projectId);
    let byChat = {};
    try { byChat = repo.tags.forProjectChats(projectId); } catch {}
    return rows.map((c) => ({ ...c, tags: byChat[c.id] || [] }));
  });
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
  ipcMain.handle('chats:unarchive', (_e, { id }) => repo.chats.unarchive(id));
  ipcMain.handle('chats:listArchived', (_e, { projectId }) => repo.chats.listArchived(projectId));
  // Permanent, and therefore confirmed MAIN-side showing what is actually
  // lost — a renderer must not be able to destroy history on its own say-so.
  ipcMain.handle('chats:delete', async (_e, { id }) => {
    const chat = repo.chats.get(id);
    if (!chat) return { ok: false, missing: true };
    const { messages } = repo.chats.contents(id);
    const ok = await confirmDelete({
      message: `Permanently delete "${chat.title || 'Untitled chat'}"?`,
      detail: `${messages} message${messages === 1 ? '' : 's'} will be erased. This cannot be undone.\n\n`
        + 'Documents this chat produced belong to the PROJECT and are kept, on disk and in the library.\n\n'
        + 'To keep the session and only clear it from the list, archive it instead.'
    });
    if (!ok) return { ok: false, cancelled: true };
    repo.chats.remove(id);
    return { ok: true };
  });
  ipcMain.handle('messages:list', (_e, { chatId }) => repo.messages.listByChat(chatId));
  ipcMain.handle('messages:add', (_e, input) => repo.messages.add(input));
  ipcMain.handle('messages:rate', (_e, { id, rating }) => repo.messages.setRating(id, rating));

}

function registerDocumentLibraryHandlers() {
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
    if (!documentPathAllowed(row.path)) throw new Error('document path is outside the documents library / project directories');
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
  ipcMain.handle('documents:list', (_e, { projectId }) => {
    const rows = repo.documents.listByProject(projectId);
    let byDoc = {};
    try { byDoc = repo.tags.forProjectDocuments(projectId); } catch {}
    return rows.map((d) => ({ ...d, tags: byDoc[d.id] || [] }));
  });
  ipcMain.handle('documents:create', (_e, input) => {
    if (input && input.path && !documentPathAllowed(input.path)) {
      throw new Error('document path must be inside the documents library or a project directory');
    }
    return repo.documents.create(input);
  });
  ipcMain.handle('documents:linkToChat', (_e, input) => repo.documents.linkToChat(input));
}

function tagFiledItem(projectId, targetId, targetType, tags) {
  for (const item of tags) {
    const tag = repo.tags.ensure(projectId, item.facet, item.name);
    if (tag && targetType === 'document') repo.tags.tagDocument(targetId, tag.id);
    if (tag && targetType === 'chat') repo.tags.tagChat(targetId, tag.id);
  }
}

async function tidyProjectDocuments({ projectId, connector, model }) {
  const tagged = repo.tags.forProjectDocuments(projectId); const filed = [];
  const documents = repo.documents.listByProject(projectId).filter((document) => !(tagged[document.id] || []).length).slice(0, 15);
  for (const document of documents) {
    let head = String(document.content || '').slice(0, 2000);
    try { if (!head && document.path && documentPathAllowed(document.path)) head = require('node:fs').readFileSync(document.path, 'utf8').slice(0, 2000); } catch {}
    const result = await librarian.fileDocument({ connector, model, meta: { title: document.title, type: document.doc_type, properties: document.properties || {} }, contentHead: head, vocabulary: buildVocabulary(projectId) });
    tagFiledItem(projectId, document.id, 'document', result.tags);
    if (result.tags.length) filed.push({ id: document.id, title: document.title, tags: result.tags.length });
  }
  return filed;
}

async function tidyProjectChats({ projectId, connector, model }) {
  const tagged = repo.tags.forProjectChats(projectId); const filed = [];
  const chats = repo.chats.listByProject(projectId).filter((chat) => !chat.summary || !(tagged[chat.id] || []).length).slice(0, 10);
  for (const chat of chats) {
    const result = await librarian.fileSession({ connector, model, messages: repo.messages.listByChat(chat.id), currentTitle: chat.title || '', vocabulary: buildVocabulary(projectId) });
    if (result.summary) repo.chats.setSummary(chat.id, result.summary);
    if (result.title && !chat.title) repo.chats.rename(chat.id, result.title);
    tagFiledItem(projectId, chat.id, 'chat', result.tags);
    if (result.summary || result.tags.length) filed.push({ id: chat.id, tags: result.tags.length });
  }
  return filed;
}

async function handleLibraryTidy(_event, { projectId, providerId, model }) {
  const provider = providerId ? repo.providers.get(providerId) : null;
  const key = provider ? repo.providers.reveal(providerId) : null;
  if (!provider || !key) return { ok: false, error: 'no provider available for the librarian' };
  const options = { projectId, connector: guardedConnector(provider, key), model: provider.fast_model || model || provider.default_model };
  let documents = []; let chats = [];
  try {
    documents = await tidyProjectDocuments(options); chats = await tidyProjectChats(options);
    return { ok: true, documents: documents.length, chats: chats.length };
  } catch (error) { return { ok: false, error: error.message, documents: documents.length, chats: chats.length }; }
}

function registerLibrarianHandlers() {

  // ── Librarian surface (O31) ───────────────────────────────────────────────
  ipcMain.handle('library:tags', (_e, { projectId }) => repo.tags.listByProject(projectId));
  ipcMain.handle('library:untagDocument', (_e, { documentId, tagId }) => { repo.tags.untagDocument(documentId, tagId); return { ok: true }; });
  ipcMain.handle('library:untagChat', (_e, { chatId, tagId }) => { repo.tags.untagChat(chatId, tagId); return { ok: true }; });
  // Batch tidy: file untagged documents and unfiled sessions (bounded per
  // run). Tags/summaries only — nothing moves on disk, everything reversible,
  // provenance recorded — so it applies directly and reports what it did.
  ipcMain.handle('library:tidy', handleLibraryTidy);
  ipcMain.handle('documents:listByChat', (_e, { chatId }) => repo.documents.listByChat(chatId));
}

async function skillImportContext(serverId) {
  const toolset = await mcpManager.buildToolset();
  const pick = (suffix) => toolset.tools.find((tool) => tool.name.endsWith(suffix) && (!serverId || (toolset.routes.get(tool.name) || {}).serverId === serverId));
  const updateTool = pick('__skills_update');
  if (!updateTool) throw new Error('That MCP server does not expose a skills_update tool (or it is not connected — sign in first).');
  const updateServerId = (toolset.routes.get(updateTool.name) || {}).serverId;
  const server = updateServerId ? repo.mcp.get(updateServerId) : null;
  return { toolset, updateTool, versionTool: pick('__version_check'), toolPrefix: server ? mcpManager.sanitize(server.name) : null };
}

async function availableSkillNames(context) {
  if (!context.versionTool) return [];
  try {
    const result = await mcpManager.callTool(context.versionTool.name, { client: 'claude' }, context.toolset.routes);
    return parseSkillNames(result.text);
  } catch (error) { console.error('[skills import] version_check', error && error.message); return []; }
}

async function installNamedSkills(context, names, emit) {
  const installed = [];
  for (let index = 0; index < names.length; index++) {
    const name = names[index]; emit({ phase: 'install', name, done: index, total: names.length });
    try {
      const result = await mcpManager.callTool(context.updateTool.name, { skill_names: [name], client: 'claude' }, context.toolset.routes);
      const fluency = parseFluencySkillItems(result.text, context.toolPrefix);
      const parsed = fluency.length ? fluency : parseSkillsPayload(result.text);
      for (const skill of parsed) { const installedName = skill.name || name; repo.skills.upsertByName({ ...skill, name: installedName }); if (!installed.includes(installedName)) installed.push(installedName); }
      if (!parsed.length) { installed.push(name); repo.skills.upsertByName({ name, definition: result.text }); }
    } catch (error) { console.error('[skills import] fetch', name, error && error.message); emit({ phase: 'error', name, error: error.message }); }
  }
  return installed;
}

async function installBulkSkills(context, emit) {
  emit({ phase: 'bulk' });
  const result = await mcpManager.callTool(context.updateTool.name, { client: 'claude' }, context.toolset.routes);
  const fluency = parseFluencySkillItems(result.text, context.toolPrefix);
  const parsed = fluency.length ? fluency : parseSkillsPayload(result.text); const installed = [];
  for (let index = 0; index < parsed.length; index++) {
    const skill = parsed[index];
    if (!skill.name) continue;
    emit({ phase: 'install', name: skill.name, done: index, total: parsed.length });
    repo.skills.upsertByName(skill); installed.push(skill.name);
  }
  return installed;
}

async function handleSkillImport(event, { serverId } = {}) {
  const emit = (progress) => { try { event.sender.send('skills:progress', progress); } catch {} };
  let context;
  try { context = await skillImportContext(serverId); }
  catch (error) { return { ok: false, error: error.message }; }
  emit({ phase: 'list' });
  const names = await availableSkillNames(context);
  if (names.length) emit({ phase: 'list-done', total: names.length });
  let installed;
  try { installed = names.length ? await installNamedSkills(context, names, emit) : await installBulkSkills(context, emit); }
  catch (error) { return { ok: false, error: error.message }; }
  emit({ phase: 'done', count: installed.length });
  return installed.length ? { ok: true, count: installed.length, names: installed } : { ok: false, error: 'No skills were returned (raw output logged).' };
}

function registerSkillHandlers() {

  // Skills + per-project scoping
  ipcMain.handle('skills:list', () => repo.skills.list());
  ipcMain.handle('skills:create', (_e, input) => repo.skills.create(input));
  ipcMain.handle('skills:enabledForProject', (_e, { projectId }) =>
    repo.skills.listEnabledForProject(projectId)
  );
  ipcMain.handle('skills:setForProject', (_e, input) => repo.skills.setForProject(input));
  ipcMain.handle('skills:update', (_e, { id, patch }) => repo.skills.update(id, patch));
  ipcMain.handle('skills:remove', (_e, { id }) => repo.skills.remove(id));

  ipcMain.handle('skills:importFromMcp', handleSkillImport);

}

function registerProviderHandlers() {
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

}

function registerGuardHandlers() {
  // Downstream LLM firewall connections. An enabled guard changes where model
  // traffic goes, so activation is confirmed in the trusted main process and
  // names the exact endpoint. Secrets only travel renderer → main.
  const confirmGuardEnable = async (guard) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Enable guard', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Route supported model traffic through ${guard.label || 'this guard'}?`,
      detail: `${guard.base_url || guard.baseUrl}\n\nPrompts, tool definitions, and model responses will pass through this endpoint. Only enable endpoints you trust.`
    });
    return r.response === 0;
  };
  ipcMain.handle('guards:list', () => repo.guards.list());
  ipcMain.handle('guards:events', (_e, { limit = 100 } = {}) => repo.guards.events(limit));
  ipcMain.handle('guards:add', async (_e, input = {}) => {
    const clean = { ...input, baseUrl: normalizeBaseUrl(input.baseUrl), authMode: input.authMode === 'bearer' ? 'bearer' : 'passthrough' };
    if (clean.kind === 'trylon') clean.authMode = 'passthrough';
    if (clean.authMode === 'bearer' && !clean.secret) return { ok: false, error: 'A bearer token is required for this guard.' };
    if (clean.enabled && !(await confirmGuardEnable(clean))) return { ok: false, cancelled: true };
    return { ok: true, guard: repo.guards.add(clean) };
  });
  ipcMain.handle('guards:update', async (_e, { id, patch = {} }) => {
    const current = repo.guards.get(id);
    if (!current) return { ok: false, error: 'Guard not found' };
    const clean = { ...patch };
    if (clean.baseUrl !== undefined) clean.baseUrl = normalizeBaseUrl(clean.baseUrl);
    if (clean.authMode !== undefined) clean.authMode = clean.authMode === 'bearer' ? 'bearer' : 'passthrough';
    const effectiveKind = clean.kind || current.kind;
    if (effectiveKind === 'trylon') clean.authMode = 'passthrough';
    const effectiveAuth = clean.authMode || current.auth_mode;
    if (effectiveAuth === 'bearer' && !clean.secret && !current.has_secret) return { ok: false, error: 'A bearer token is required for this guard.' };
    if (clean.enabled === true && !current.enabled) {
      const preview = { ...current, ...clean, base_url: clean.baseUrl || current.base_url };
      if (!(await confirmGuardEnable({ ...preview, base_url: undefined, baseUrl: preview.base_url }))) return { ok: false, cancelled: true };
    }
    return { ok: true, guard: repo.guards.update(id, clean) };
  });
  ipcMain.handle('guards:remove', (_e, { id }) => { repo.guards.remove(id); return { ok: true }; });
  ipcMain.handle('guards:test', async (_e, input = {}) => {
    let guard; let secret;
    const testsSavedConfiguration = !!input.id && input.baseUrl === undefined && input.authMode === undefined && input.secret === undefined;
    if (input.id) {
      const saved = repo.guards.get(input.id);
      guard = saved;
      if (!guard) return { ok: false, error: 'Guard not found' };
      secret = input.secret || repo.guards.reveal(input.id);
      if (input.baseUrl !== undefined) guard = { ...guard, base_url: normalizeBaseUrl(input.baseUrl) };
      if (input.authMode !== undefined) guard = { ...guard, auth_mode: input.authMode === 'bearer' ? 'bearer' : 'passthrough' };
    } else {
      guard = { base_url: normalizeBaseUrl(input.baseUrl), auth_mode: input.authMode === 'bearer' ? 'bearer' : 'passthrough' };
      secret = input.secret || null;
    }
    const result = await testGuard({ baseUrl: guard.base_url, authMode: guard.auth_mode, secret });
    if (testsSavedConfiguration) repo.guards.update(input.id, { status: result.ok ? 'ok' : 'error', statusDetail: result.error || result.detail || null, markChecked: true });
    return result;
  });

}

async function outdatedServerSkills(toolset, server, prefix, localSkills) {
  const versionTool = toolset.tools.find((tool) => tool.name === prefix + 'version_check');
  if (!versionTool) return [];
  try {
    const result = await mcpManager.callTool(versionTool.name, { client: 'claude' }, toolset.routes);
    const remote = parseSkillVersions(result.text); const outdated = [];
    for (const skill of localSkills) {
      const remoteVersion = remote[skill.name];
      const localVersion = String((parseFrontmatter(skill.definition || '').meta || {}).version || '');
      if (remoteVersion && localVersion && localVersion !== remoteVersion) outdated.push({ name: skill.name, local: localVersion, remote: remoteVersion });
    }
    return outdated;
  } catch (error) { console.error('[mcp checkSync] version_check', server.name, error && error.message); return []; }
}

async function serverSyncResult(toolset, server, localSkills) {
  const prefix = mcpManager.sanitize(server.name) + '__';
  const live = toolset.tools.filter((tool) => (toolset.routes.get(tool.name) || {}).serverId === server.id).map((tool) => tool.name.replace(prefix, '')).sort();
  if (!live.length) return null;
  const cached = (server.tools || []).map((tool) => tool.name).sort();
  const toolsAdded = live.filter((tool) => !cached.includes(tool));
  const toolsRemoved = cached.filter((tool) => !live.includes(tool));
  const skillsOutdated = await outdatedServerSkills(toolset, server, prefix, localSkills);
  return { serverId: server.id, name: server.name, toolsAdded: toolsAdded.length, toolsRemoved: toolsRemoved.length, skillsOutdated, drift: !!(toolsAdded.length || toolsRemoved.length || skillsOutdated.length) };
}

async function handleMcpSyncCheck(_event, { serverId } = {}) {
  let toolset;
  try { toolset = await mcpManager.buildToolset(); }
  catch (error) { return { ok: false, error: error.message }; }
  const servers = repo.mcp.list().filter((server) => server.enabled && (!serverId || server.id === serverId));
  const localSkills = repo.skills.list(); const results = [];
  for (const server of servers) {
    const result = await serverSyncResult(toolset, server, localSkills);
    if (result) results.push(result);
  }
  return { ok: true, servers: results };
}

function registerMcpHandlers() {
  // MCP servers — metadata only out; env/token stay in main.
  ipcMain.handle('mcp:list', () => repo.mcp.list());
  ipcMain.handle('mcp:authStatus', (_e, { serverId } = {}) => mcpManager.authStatus(serverId));
  if (!mcpAuthBroadcastInstalled) {
    mcpAuthBroadcastInstalled = true;
    mcpManager.onAuthStatus((status) => {
      for (const win of BrowserWindow.getAllWindows()) { try { win.webContents.send('mcp:auth-status', status); } catch {} }
    });
  }
  // A stdio MCP server is an arbitrary command this app will spawn — that
  // decision is confirmed in MAIN, not taken on a renderer message alone
  // (mcp:add + mcp:connect was renderer-to-RCE with no second wall).
  const confirmMcpCommand = async (command, args) => {
    if (!command) return true; // http transport — no spawn
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Allow this MCP server command?',
      detail: `The app will run:\n\n${command} ${(args || []).join(' ')}\n\nOnly allow commands you recognize.`
    });
    return r.response === 0;
  };
  ipcMain.handle('mcp:add', async (_e, input) => {
    if (!(await confirmMcpCommand(input && input.command, input && input.args))) return { ok: false, cancelled: true };
    return repo.mcp.add(input);
  });
  ipcMain.handle('mcp:update', async (_e, { id, patch }) => {
    // Re-confirm only when the spawned command actually changes.
    if (patch && (patch.command !== undefined || patch.args !== undefined)) {
      const cur = repo.mcp.get(id) || {};
      const nextCmd = patch.command !== undefined ? patch.command : cur.command;
      const nextArgs = patch.args !== undefined ? patch.args : (cur.args || []);
      const changed = nextCmd !== cur.command || JSON.stringify(nextArgs) !== JSON.stringify(cur.args || []);
      if (changed && !(await confirmMcpCommand(nextCmd, nextArgs))) return { ok: false, cancelled: true };
    }
    return repo.mcp.update(id, patch);
  });
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
  ipcMain.handle('mcp:checkSync', handleMcpSyncCheck);
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
      mcpManager.noteAuthorized(id, tokenSet.expires_at);
      return { ok: true, scope: tokenSet.scope };
    } catch (e) {
      console.error('[mcp oauth]', e && (e.stack || e.message));
      repo.mcp.update(id, { status: 'error', statusDetail: `auth: ${e.message || 'failed'}` });
      return { ok: false, error: e.message };
    }
  });

}

function registerChatExecutionHandler() {
  // Chat — route to the selected provider connection; requires one to be set.
  ipcMain.handle('chat:send', async function handleChatSend(_e, payload) {
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
    let plannerText = attachments.length
      ? text + '\n\nFILES ATTACHED TO THIS MESSAGE — already saved in the project. Read them with read_file at these exact paths; do NOT ask the user where they are:\n'
        + attachments.map((a) => `- ${a.path || a.name}${a.chars ? ` (${a.chars} chars)` : ''}`).join('\n')
      : text;

    async function runProviderTurn() {
      async function initializeProviderTurn() {
      function selectedProviderConfiguration() {
        const selected = repo.providers.get(providerId);
        if (!selected) throw new Error('Selected connection no longer exists.');
        if (!selected.enabled) throw new Error(`${selected.label || selected.type} is disabled.`);
        const secret = repo.providers.reveal(providerId);
        if (!secret) throw new Error(`No API key stored for ${selected.label || selected.type}.`);
        const selectedModel = model || selected.default_model;
        return { provider: selected, key: secret, chosenModel: selectedModel, fastModel: selected.fast_model || selectedModel };
      }
      function loadWorkflowResume(chatId) {
        const output = { workflowResume: null, workflowCheckpoints: [], workflowResumeContext: '' };
        const asked = !!payload?.resumeRunId || /^\s*(?:continue|resume|retry)\b/i.test(text);
        if (!chatId || !asked) return output;
        const candidate = payload?.resumeRunId ? repo.workflowRuns.get(payload.resumeRunId) : repo.workflowRuns.latestIncomplete(chatId);
        if (!candidate || Number(candidate.chat_id) !== Number(chatId)) return output;
        output.workflowResume = candidate;
        output.workflowCheckpoints = repo.workflowRuns.checkpoints(candidate.id);
        output.workflowResumeContext = renderResumeContext(candidate, output.workflowCheckpoints);
        emitProgress({ type: 'process', kind: 'workflow-resume', runId: candidate.id, checkpoints: output.workflowCheckpoints.length });
        return output;
      }
      const { provider, key, chosenModel, fastModel } = selectedProviderConfiguration();
      const turnId = (payload && payload.turnId) ? String(payload.turnId) : `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
      const emitProgress = (ev) => { try { _e.sender.send('chat:progress', { turnId, ...ev }); } catch {} };
      const turnStart = Date.now();
      const chatId = payload?.chatId || null;
      const requestChat = chatId ? repo.chats.get(chatId) : null;
      const requestMode = (requestChat && (requestChat.mode || (requestChat.coding_mode ? 'code' : ''))) || 'work';
      let resume = { workflowResume: null, workflowCheckpoints: [], workflowResumeContext: '' };
      try { resume = loadWorkflowResume(chatId); } catch (error) { console.error('[workflow resume]', error && error.message); }
      const { workflowResume, workflowCheckpoints, workflowResumeContext } = resume;
      if (workflowResumeContext) plannerText += '\n\n' + workflowResumeContext;
      const workflowContract = workflowResume && workflowResume.contract && Object.keys(workflowResume.contract).length
        ? workflowResume.contract
        : createWorkflowContract({ text: plannerText, mode: requestMode, turnId });
      plannerText += '\n\n' + renderContract(workflowContract);
      let workflowRun = null;
      let workflowAcceptance = null;
      const taskLog = []; // per-task timing/tokens (sub-agents; tools added post-loop)
      const connector = guardedConnector(provider, key, { chatId, turnId });
      return { provider, chosenModel, fastModel, turnId, emitProgress, turnStart, chatId, workflowResume, workflowCheckpoints, workflowResumeContext, workflowContract, workflowRun, workflowAcceptance, taskLog, connector };
      }
      let { provider, chosenModel, fastModel, turnId, emitProgress, turnStart, chatId, workflowResume, workflowCheckpoints, workflowResumeContext, workflowContract, workflowRun, workflowAcceptance, taskLog, connector } = await initializeProviderTurn();

      // STOP support (abort + save work): the renderer's STOP button fires
      // chat:abort. The signal kills the in-flight provider HTTP call, and
      // every loop checks isAborted() at its next boundary — variables,
      // step results, tool trace, and metrics are all still persisted.
      function prepareInteractionRuntime() {
      let aborted = false;
      const turnAbort = new AbortController();
      const abortListener = (_ev, p) => {
        if (p && p.turnId && p.turnId !== turnId) return; // someone else's turn
        aborted = true; try { turnAbort.abort(); } catch {} emitProgress({ type: 'process', kind: 'abort' });
      };
      ipcMain.on('chat:abort', abortListener);
      const isAborted = () => aborted;
      const securityState = { block: null, usage: null };
      // A blocked turn still spent everything it spent before the block.
      const mergeBlockedUsage = (aggregate, blocked) => {
        if (!aggregate && !blocked) return null;
        if (!aggregate) return blocked;
        if (!blocked) return aggregate;
        const add = (k) => (aggregate[k] || 0) + (blocked[k] || 0);
        return {
          ...aggregate,
          inputTokens: add('inputTokens'), outputTokens: add('outputTokens'),
          cachedTokens: add('cachedTokens'), cacheCreationTokens: add('cacheCreationTokens'),
          calls: add('calls'), measured: !!(aggregate.measured || blocked.measured)
        };
      };
      const firewallError = () => {
        const error = new Error((securityState.block && securityState.block.message) || 'Model traffic was blocked by the configured guard.');
        error.code = 'LLM_GUARD_BLOCKED';
        error.security = securityState.block;
        return error;
      };
      const chatAbortable = async (a) => {
        // A planner may retry a failed structured-output call. Once the guard
        // has blocked this turn, every later model attempt is stopped here
        // without touching the network again.
        if (securityState.block) throw firewallError();
        const response = await connector.chat({
          ...a,
          signal: combineAbortSignals([turnAbort.signal, a && a.signal]),
          // Connector-level retry (429/overload/transient 5xx) surfaces in the
          // glass box instead of looking like a silent stall.
          onRetry: (r) => emitProgress({ type: 'process', kind: 'retry', attempt: r.attempt, status: r.status, delayMs: r.delayMs })
        });
        if (response && response.security && response.security.blocked) {
          securityState.block = response.security;
          securityState.usage = response.usage || null;
          throw firewallError();
        }
        return response;
      };
      // Ordinary planning and chat retain the provider's 180s default. Only
      // workflow execution steps receive the contract-scoped extended bound.
      const workflowStepChat = (a) => chatAbortable({ ...a, timeoutMs: effectiveProviderResponseBudget(workflowContract) });

      // One-shot user prompts (limit / stuck / action-approve): emit an event,
      // await the reply on chat:continue. Waiters are a FIFO queue — parallel
      // sub-agents can each be awaiting an approval, and a single shared slot
      // would resolve the wrong waiter (the loser hanging to its timeout).
      // No reply in 180s, or a STOP, resolves 0.
      const promptWaiters = [];
      const promptListener = (_ev, payload) => {
        if (payload && payload.turnId && payload.turnId !== turnId) return; // another turn's reply
        const w = promptWaiters.shift(); if (w) w(Number(payload && payload.more) || 0);
      };
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
      return { isAborted, mergeBlockedUsage, firewallError, chatAbortable, workflowStepChat, askUser, promptListener, abortListener, securityState };
      }
      const { isAborted, mergeBlockedUsage, firewallError, chatAbortable, workflowStepChat, askUser, promptListener, abortListener, securityState } = prepareInteractionRuntime();

      async function prepareTurnContext() {
      const projectId = payload?.projectId;
      async function loadWorkflowToolset() {
        let available = { tools: [], routes: new Map() };
        try { available = await mcpManager.buildToolset(projectId); } catch (error) { console.error('[mcp] buildToolset', error && error.message); }
        const inspected = available.tools.length; const filtered = filterMcpToolset(workflowContract, available);
        if (filtered.blocked) emitProgress({ type: 'process', kind: 'workflow-tool-policy', workflow: workflowContract.kind, category: 'mcp', inspected, allowed: 0, blocked: filtered.blocked });
        return filtered;
      }
      function loadProjectSkills(toolset) {
        if (!projectId) return [];
        let skills = [];
        try { skills = repo.skills.listEnabledForProject(projectId); } catch (error) { console.error('[skills]', error && error.message); }
        if (workflowContract.toolPolicy && workflowContract.toolPolicy.projectSkills === 'deny') {
          emitProgress({ type: 'process', kind: 'workflow-tool-policy', workflow: workflowContract.kind, category: 'project-skills', inspected: skills.length, allowed: 0, blocked: skills.length });
          return [];
        }
        try { return skills.map((skill) => enrichSkillRow(skill, toolset.tools.map((tool) => tool.name))); }
        catch (error) { console.error('[skills enrich]', error && error.message); return skills; }
      }
      async function selectTurnContext(skills, toolset) {
        try {
          const selection = await selectContext({ connector: { chat: chatAbortable }, model: fastModel, skills, tools: toolset.tools, userText: plannerText });
          if (selection.error) console.warn('[context-select]', selection.error);
          if (selection.skillMismatch) console.warn('[context-select] mismatch —', selection.skillMismatch);
          if (selection.toolMismatch) console.warn('[context-select] mismatch —', selection.toolMismatch);
          return selection;
        } catch (error) { console.error('[context-select]', error && error.message); return { skillNames: [], toolNames: [], error: error.message }; }
      }
      function injectSelectedSkills(skills, selection) {
        if (!skills.length) return { base: messages, skillSelect: null, loadedSkills: [] };
        const names = new Set(selection.skillNames.map((name) => name.toLowerCase()));
        const loadedSkills = skills.filter((skill) => names.has(skill.name.toLowerCase()));
        const fullTokens = estimateTokens(skills.map((skill) => ({ content: skill.definition || skill.description || '' })));
        const loadedTokens = estimateTokens(loadedSkills.map((skill) => ({ content: skill.definition || skill.description || '' })));
        const skillSelect = { available: skills.length, selected: loadedSkills.map((skill) => skill.name), fullTokens, loadedTokens, savedTokens: Math.max(0, fullTokens - loadedTokens), error: selection.error || selection.skillMismatch };
        const menu = skills.map((skill) => `- ${skill.name}: ${String(skill.description || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
        const loaded = loadedSkills.map((skill) => `## ${skill.name}\n${skill.definition || skill.description || ''}`).join('\n\n');
        const system = 'Project skills — you can use these. Menu (name — when to use):\n' + menu + (loaded ? '\n\nInstructions loaded for this turn:\n\n' + loaded : '\n\n(No skill instructions loaded this turn. If one of the above is needed, say so.)');
        emitProgress({ type: 'process', kind: 'skill-select', available: skillSelect.available, selected: skillSelect.selected, savedTokens: skillSelect.savedTokens });
        return { base: [{ role: 'system', content: system }, ...messages], skillSelect, loadedSkills };
      }
      async function compressTurnContext(base) {
        if (securityState.block) return { convo: base, compressed: false };
        try {
          const output = await maybeCompress({ messages: base, contextWindow: contextWindowFor(chosenModel), summarize: async (older) => {
            const response = await chatAbortable({ model: fastModel, messages: [{ role: 'user', content: SUMMARY_PROMPT + renderForSummary(older) }], maxTokens: 700 });
            return response.text || '';
          } });
          return { convo: output.messages, compressed: output.compressed };
        } catch (error) { if (error && error.code !== 'LLM_GUARD_BLOCKED') console.error('[compress]', error && error.message); return { convo: base, compressed: false }; }
      }
      function scopeTurnTools(toolset, loadedSkills, selection) {
        if (!toolset.tools.length) return { scopedTools: toolset.tools, toolScope: null };
        const ceiling = applyToolCeiling({ loadedSkills, toolNames: selection.toolNames, allTools: toolset.tools, selectionSucceeded: !!selection.selectionSucceeded });
        const toolScope = { totalAvailable: toolset.tools.length, scoped: ceiling.tools.length, bySkills: ceiling.bySkills, fellBack: ceiling.fellBack };
        if (ceiling.fellBack) console.warn('[context-select] no usable tool picks — falling back to the full catalog' + (selection.error ? ` (${selection.error})` : ''));
        emitProgress({ type: 'process', kind: 'tool-scope', ...toolScope });
        return { scopedTools: ceiling.tools, toolScope };
      }
      const toolset = await loadWorkflowToolset();
      const enabledSkills = loadProjectSkills(toolset);
      const planned = await selectTurnContext(enabledSkills, toolset);
      const skillContext = injectSelectedSkills(enabledSkills, planned);
      const { base, skillSelect, loadedSkills } = skillContext;
      let { convo, compressed } = await compressTurnContext(base);
      let { scopedTools, toolScope } = scopeTurnTools(toolset, loadedSkills, planned);
      return { projectId, toolset, base, skillSelect, loadedSkills, convo, compressed, scopedTools, toolScope };
      }
      let { projectId, toolset, base, skillSelect, loadedSkills, convo, compressed, scopedTools, toolScope } = await prepareTurnContext();

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
      function prepareTurnMode() {
      const project = projectId ? repo.projects.get(projectId) : null;
      const chatRow = chatId ? repo.chats.get(chatId) : null;
      const chatMode = (chatRow && (chatRow.mode || (chatRow.coding_mode ? 'code' : ''))) || 'work';
      const globalBase = repo.settings.get('documents_base') || docs.defaultBase();
      const outputDir = docs.resolveOutputDir(project, globalBase);
      // Canonical docs live WITH the code when a working dir exists — in the
      // repo (git-versioned, visible to the agent's own file tools and to any
      // repo analysis), else in the document library.
      const docsBase = (project && project.working_dir) || outputDir;
      const artifactBaseline = new Map();
      try {
        if (chatId) for (const d of repo.documents.listByChat(chatId)) artifactBaseline.set(d.id, { version: d.version, updated_at: d.updated_at });
      } catch {}
      let coding = null;
      let library = null;
      let formatTarget = '';
      let branding = '';
      let rawData = false;
      function resolveDocumentTargets() {
        try {
          const fsx = require('node:fs'); const px = require('node:path');
          formatTarget = String(repo.settings.get('output_format', projectId) || '').trim();
          if (!formatTarget) {
            const formats = fsx.readdirSync(px.join(outputDir, 'formats')).filter((file) => file.toLowerCase().endsWith('.html'));
            if (formats.length === 1) formatTarget = px.join('formats', formats[0]);
          }
        } catch {}
        try { branding = String(repo.settings.get('output_branding', projectId) || '').trim(); } catch {}
        try { rawData = repo.settings.get('output_rawdata', projectId) === '1'; } catch {}
      }
      function documentFormatInstructions() {
        return formatTarget ? '\n\nOUTPUT FORMAT TARGET: "' + formatTarget + '" in the document library is the visual standard for every document you produce. Read it with read_file BEFORE composing, and reproduce its fonts, masthead, header block, numbered section headings, tables, chart styling, callouts, spacing, and print rules EXACTLY — replacing the sample content with this turn\'s real content. Branding and layout come from the format target; sections and data come from the task and skill. The format\'s web-font stylesheet links are the only permitted external references; keep every font-family fallback stack so offline rendering degrades gracefully.' : '';
      }
      function documentTargetInstructions() {
        const brand = branding ? '\n\nTARGET DOCUMENT BRANDING (apply to every deliverable, on top of the format): ' + branding : '';
        const data = rawData ? '\n\nRAW DATA EXPORT IS ON: alongside every report, also save the collected tabular data as a spreadsheet — save_document with format "xlsx", type "raw-data", the same title plus " — Data", the same properties, and content as JSON {"sheets":[{"name":"…","rows":[[header…],[values…]]}]} (one sheet per dataset; the app renders the Excel file deterministically).' : '';
        const missing = (!formatTarget || !branding) ? '\n\nDOCUMENT TARGETS MISSING: ' + [!formatTarget ? 'Target Document Format' : '', !branding ? 'Target Document Branding' : ''].filter(Boolean).join(' and ') + ' is not set for this project. Before producing a document, ask the user for the missing target(s) — they can answer here in chat or set it on the project OVERVIEW page under DOCUMENT TARGETS. Do not silently invent branding or a format.' : '';
        return brand + data + missing;
      }
      function documentModeInstructions(sourceReadRoots) {
        const source = sourceReadRoots.length ? ' plus the project source directory at ' + sourceReadRoots[0] : '';
        const libraryList = projectId ? projectDocs.listLibrary(projectId) : '';
        return 'DOCUMENTS MODE: the deliverable of this chat is documents, not chat prose. Produce or update documents with the save_document tool — reports, briefs, specs, analyses, exports — which saves into the project document library, versioned and filed. A substantial answer should land as a saved document, with the chat reply a short summary that names the saved file. The document library is at ' + outputDir + ' — read_file, list_dir, and grep_files are jailed to it' + source + ', so you can read and build on every document already there and inspect project source read-only. When the user iterates on a document, save the revision under the same title and type rather than creating a near-duplicate. Use research tools to collect material and track which source supports each claim.' + documentFormatInstructions() + documentTargetInstructions() + (libraryList ? '\n\nPROJECT LIBRARY — documents already saved for this project; read them at these exact paths:\n' + libraryList : '');
      }
      function configureDocumentsMode() {
        if (chatMode !== 'documents') return;
        // The documents harness (O20/O22), built on the coding-harness
        // pattern: a jailed tool pack + a mode note + planner rules. Hands
        // differ — read-only, jailed to the LIBRARY; no shell; publication
        // goes through save_document (versioned, indexed, placed).
        const sourceReadRoots = (project && project.working_dir && path.resolve(project.working_dir) !== path.resolve(outputDir))
          ? [project.working_dir] : [];
        library = buildLibraryTools({ root: outputDir, readRoots: sourceReadRoots });
        // Web tools join the planning menu like coding mode — collection is
        // research, and the planner must see the collection tools to plan it.
        scopedTools = [...scopedTools, ...library.tools, ...webTools.WEB_TOOLS];
        resolveDocumentTargets();
        convo = [{ role: 'system', content: documentModeInstructions(sourceReadRoots) }, ...convo];
        emitProgress({ type: 'process', kind: 'documents-mode', outputDir, tools: library.tools.length, formatTarget, branding: !!branding, rawData });
      }
      function projectBuildEnvironment() {
        const environment = {};
        try {
          for (const line of String(repo.settings.get('build_env', projectId) || '').split('\n')) {
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (match) environment[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
          }
        } catch {}
        return environment;
      }
      function codingModeInstructions(gitAvailable, buildEnv, rulebook) {
        const filePolicy = gitAvailable ? 'File writes/edits are auto-approved (git provides rollback); shell commands pause for the user to approve. ' : 'Each write, edit, or shell command pauses for the user to approve (no git repo — no rollback). ';
        const environment = Object.keys(buildEnv).length ? ' Build environment variables set for this project: ' + Object.keys(buildEnv).join(', ') + '.' : '';
        const check = coding.checkCommand ? `\n\nPROJECT CHECK: the framework runs \`${coding.checkCommand}\` after your changes and it must pass. A failure comes back to you with its output; fix the root cause.` : '';
        const rules = coding.rulebook ? '\n\nPROJECT RULEBOOK (' + rulebook.relPath + ' — non-negotiable rules for all work in this repository):\n' + String(coding.rulebook).slice(0, 6000) : '';
        const libraryList = projectId ? projectDocs.listLibrary(projectId) : '';
        const libraryNote = libraryList ? '\n\nPROJECT LIBRARY — documents and uploaded files already saved for this project. Read them at these exact paths; do not ask the user to locate them:\n' + libraryList : '';
        return 'CODING MODE: file and shell tools are available. Allowed directories: the project working directory ' + project.working_dir + ' (relative paths resolve here) and the project documents directory ' + outputDir + '. File actions outside those directories are refused. Reads are free. ' + filePolicy + 'If an action is declined, continue without it. Read a file before editing it; edit_file replaces an exact existing string. run_command executes in the working directory and is KILLED when it returns — start long-running processes with start_server and read their output with server_logs. NEVER delete, skip, or weaken a failing test to make it pass — fix the root cause; if a test itself is wrong, say so explicitly when changing it.' + environment + check + rules + libraryNote;
      }
      function configureCodingMode() {
        if (chatMode !== 'code') return;
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
            // Level-3 bypass. In practice this is a SHELL bypass — writes are
            // already free with git — and git does NOT roll back shell effects
            // (network calls, installs, deletes outside the tree). The honest
            // framing lives where the setting is granted: the main-process
            // confirmation dialog (settings:set) states exactly that risk, so
            // the standing grant is an informed one and cannot be flipped by a
            // renderer message alone.
            try { if (gitNow() && repo.settings.get('coding_bypass', projectId) === '1') return true; } catch {}
            return (await askUser({ type: 'action-approve', kind, summary, gitAvailable: gitNow() })) > 0;
          };
          // Project build environment (Overview → BUILD ENVIRONMENT): KEY=VALUE
          // lines merged into every command and server the model runs, so
          // builds get what they need without inheriting the app's secrets.
          const buildEnv = projectBuildEnvironment();
          coding = buildCodingTools({ root: project.working_dir, docsRoot: outputDir, approveAction, buildEnv, projectId });
          coding.root = project.working_dir;         // for step-commits (O9)
          coding.gitAvailable = gitAvailable;
          coding.buildEnv = buildEnv;
          // O29: the repo speaks first — the working-dir rulebook rides into
          // the CODING MODE note (execution) and Pass 2 (planning). Missing
          // rulebook = silent passthrough; found = a visible ledger event.
          const rb = projectDocs.readRulebook(project.working_dir);
          coding.rulebook = rb ? rb.text : '';
          if (rb) emitProgress({ type: 'process', kind: 'rulebook', path: rb.relPath, chars: rb.text.length });
          // O26: the framework check gate. The BASELINE runs lazily — just
          // before this turn's first mutation (see ensureBaseline) — so a
          // question-only turn never pays for a slow test suite, while
          // pre-existing breakage is still attributed rather than inherited.
          coding.checkCommand = String(repo.settings.get('check_command', projectId) || '').trim();
          // Web tools join the planning menu in coding mode — docs lookup and
          // error-message searches are part of real development.
          scopedTools = [...scopedTools, ...coding.tools, ...webTools.WEB_TOOLS];
          convo = [{ role: 'system', content: codingModeInstructions(gitAvailable, buildEnv, rb) }, ...convo];
          emitProgress({ type: 'process', kind: 'coding-mode', root: project.working_dir, docsRoot: outputDir, tools: coding.tools.length, gitAvailable, rulebook: !!rb, check: !!coding.checkCommand });
        } else {
          console.warn('[coding-mode] chat has coding mode on but the project has no working_dir — tools not offered');
        }
      }
      configureDocumentsMode();
      configureCodingMode();
      return { project, outputDir, docsBase, artifactBaseline, coding, library, formatTarget, branding, rawData };
      }
      const { project, outputDir, docsBase, artifactBaseline, coding, library, formatTarget, branding, rawData } = prepareTurnMode();

      // The planner already sees this digest in plannerText. Execution does
      // not: it receives convo. Without this second injection a resume knows
      // which delegated step to skip but loses the evidence that step found.
      convo = withResumeContext(convo, workflowResumeContext);

      // ── O26: the check gate's turn-scoped state ─────────────────────────
      // One closure owns every check run this turn — each is a process event,
      // and the LAST verdict is what synthesis, review, and the debt ledger
      // see. Defined here (not inside the execution branch) so the tool
      // wrapper below can trigger the lazy baseline.
      function prepareCheckRuntime() {
      const checkState = { ran: false, failing: false, output: '', baselineFailing: false };
      const runTurnCheck = async (phase, step) => {
        if (!coding || !coding.checkCommand) return null;
        emitProgress({ type: 'process', kind: 'check', phase, step: step && step.id, command: coding.checkCommand });
        const c = await runCheckCommand(coding.root, coding.checkCommand, coding.buildEnv);
        checkState.ran = true; checkState.failing = !c.ok; checkState.output = c.output;
        emitProgress({ type: 'process', kind: c.ok ? 'check-pass' : 'check-failed', phase });
        // Attribution: a check that was ALREADY failing before this turn
        // touched anything is not this turn's doing — say so where the model
        // reads it, so it fixes the root cause without owning old breakage.
        if (!c.ok && checkState.baselineFailing) {
          c.output = 'NOTE: this check was ALREADY FAILING before this turn made any change — the pre-existing failures are not yours.\n' + c.output;
        }
        return c;
      };
      // The baseline runs ONCE, lazily, immediately before the turn's first
      // mutation: a question-only turn never pays for a slow suite, and the
      // attribution property is preserved because nothing has changed yet.
      let baselineDone = false;
      const ensureBaseline = async () => {
        if (baselineDone || !coding || !coding.checkCommand) return;
        baselineDone = true;
        emitProgress({ type: 'process', kind: 'check', phase: 'baseline', command: coding.checkCommand });
        const c = await runCheckCommand(coding.root, coding.checkCommand, coding.buildEnv);
        checkState.baselineFailing = !c.ok;
        emitProgress({ type: 'process', kind: c.ok ? 'check-pass' : 'check-failed', phase: 'baseline' });
      };
      return { checkState, runTurnCheck, ensureBaseline };
      }
      const { checkState, runTurnCheck, ensureBaseline } = prepareCheckRuntime();

      // Orchestrator gets the MCP tools PLUS `delegate`; sub-agents get the MCP
      // tools only (no `delegate`) so the tree stays one level deep. Coding
      // tools (no `__` namespace) route to the pack; everything else to MCP.
      // Sub-agents share this router, so their mutations trigger the baseline
      // too — the third path is not exempt from attribution.
      async function prepareTurnToolRuntime() {
      const turnToolCache = new TurnToolCache(toolset.tools, (name) => {
        emitProgress({ type: 'process', kind: 'tool-cache-hit', name });
      });
      const uncachedCallTool = async (name, args) => {
        if (coding && coding.checkCommand && MUTATING_TOOLS.includes(name)) {
          try { await ensureBaseline(); } catch (e) { console.error('[check baseline]', e && e.message); }
        }
        const local = (coding && coding.names.has(name)) || (library && library.names.has(name)) || webTools.names.has(name);
        if (!local && workflowContract.toolPolicy && workflowContract.toolPolicy.mcp === 'deny') {
          emitProgress({ type: 'process', kind: 'workflow-tool-blocked', workflow: workflowContract.kind, name });
          return { text: `Tool ${name} is outside the ${workflowContract.kind} workflow policy. Connected MCP tools are not available for this task.`, isError: true };
        }
        return (coding && coding.names.has(name))
          ? coding.call(name, args)
          : (library && library.names.has(name))
            ? library.call(name, args)
            : webTools.names.has(name)
              ? webTools.call(name, args)
              : mcpManager.callTool(name, args, toolset.routes);
      };
      // This is the shared boundary for orchestrator AND delegated calls. A
      // first version cached only inside callTool below; runSubagent receives
      // rawCallTool directly, so delegated report collection bypassed the
      // snapshot and could still pull a second, contradictory live result.
      const rawCallTool = (name, args) => turnToolCache.call(name, args, () => uncachedCallTool(name, args));

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
      const saveCanonicalDocument = (args, canonicalType) => {
        if (!projectId || !projectDocs.CANONICAL[canonicalType]) return null;
        const written = projectDocs.writeCanonical({ projectId, docsBase, docType: canonicalType, content: args.content || '', source: 'chat' });
        emitProgress({ type: 'process', kind: 'doc-update', doc: canonicalType, version: written.version });
        emitProgress({ type: 'document-saved', title: projectDocs.CANONICAL[canonicalType], path: written.absPath, relPath: written.relPath, version: written.version, mime: 'text/markdown' });
        return { text: `Updated ${written.relPath} (v${written.version}) — the project's canonical ${canonicalType} document.` };
      };
      const spreadsheetContent = (args) => {
        if (!/^(xlsx?|spreadsheet|excel)$/i.test(String(args.format || ''))) return { format: args.format, content: args.content || '' };
        try { return { format: 'xls', content: require('./spreadsheet').sheetsToXml(JSON.parse(String(args.content || ''))) }; }
        catch (error) { return { error: `save_document (spreadsheet): content must be JSON {sheets:[{name, rows:[[…]]}]} — ${error.message}` }; }
      };
      const filedDocumentMetadata = async (args, format) => {
        const meta = { type: args.type, title: args.title, format, properties: { ...(args.properties || {}) } };
        if (!projectId || isAborted()) return { meta, filed: { tags: [] } };
        const filed = await librarian.fileDocument({ connector: { chat: chatAbortable }, model: fastModel, meta: { title: args.title, type: args.type, properties: args.properties || {} }, contentHead: String(args.content || '').slice(0, 2000), vocabulary: buildVocabulary(projectId) });
        if (filed.docType) meta.type = filed.docType;
        if (filed.entity && !meta.properties.tenant && !meta.properties.company) meta.properties.tenant = filed.entity;
        if (filed.period && !meta.properties.period && !meta.properties.date) meta.properties.period = filed.period;
        return { meta, filed };
      };
      const revisionTarget = (meta) => {
        const path = store && store.get('existing_report_path');
        const documents = projectId ? repo.documents.listByProject(projectId) : [];
        const explicit = path ? documents.find((document) => document.path === path) : null;
        const titled = workflowContract.kind === 'mode-flow' ? documents.filter((document) => String(document.title || '').toLowerCase() === String(meta.title || '').toLowerCase() && (!meta.type || !document.doc_type || String(document.doc_type) === String(meta.type))).sort((a, b) => Number(b.id) - Number(a.id))[0] : null;
        const revision = explicit || titled || null;
        if (!revision || (meta.type && revision.doc_type && String(meta.type) !== String(revision.doc_type))) return null;
        meta.title = revision.title;
        if (titled && titled.properties_json) { try { meta.properties = JSON.parse(titled.properties_json) || {}; } catch {} }
        emitProgress({ type: 'process', kind: 'document-revision-target', id: revision.id, path: revision.path });
        return revision;
      };
      const indexGeneratedDocument = (meta, written, revision) => {
        let row = null;
        try { row = repo.documents.saveGenerated({ projectId, title: meta.title || written.relPath, path: written.absPath, mimeType: written.mime, source: 'chat', docType: meta.type || null, version: written.version, properties: Object.keys(meta.properties).length ? meta.properties : null }); }
        catch (error) { console.error('[save_document index]', error && error.message); }
        if (row && chatId) {
          try { repo.documents.linkToChat({ chatId, documentId: row.id, relation: revision ? 'edited' : 'created' }); }
          catch (error) { console.error('[save_document chat link]', error && error.message); }
        }
        return row;
      };
      const tagGeneratedDocument = (row, filed, meta) => {
        if (!row || !filed.tags.length) return;
        try {
          tagFiledItem(projectId, row.id, 'document', filed.tags);
          emitProgress({ type: 'process', kind: 'librarian-filed', target: 'document', title: meta.title, docType: meta.type || null, tags: filed.tags.map((tag) => `${tag.facet}:${tag.name}`) });
        } catch (error) { console.error('[librarian tags]', error && error.message); }
      };
      const saveDocument = async (args) => {
        const canonicalType = String(args.type || '').toLowerCase();
        const canonical = saveCanonicalDocument(args, canonicalType);
        if (canonical) return canonical;
        const content = spreadsheetContent(args);
        if (content.error) return { text: content.error, isError: true };
        const { meta, filed } = await filedDocumentMetadata(args, content.format);
        const revision = revisionTarget(meta);
        const written = docs.writeDocument({ outputDir, template: placementTemplate, meta, content: content.content });
        const row = indexGeneratedDocument(meta, written, revision);
        tagGeneratedDocument(row, filed, meta);
        emitProgress({ type: 'document-saved', id: row && row.id, title: meta.title, path: written.absPath, relPath: written.relPath, version: written.version, mime: written.mime });
        return { text: `Saved "${meta.title}" → ${written.relPath} (v${written.version}) in the document library. Full path: ${written.absPath}` };
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
      try {
        const last = workflowCheckpoints[workflowCheckpoints.length - 1];
        if (last && last.values) store = VariableStore.fromJSON(last.values);
      } catch (e) { console.error('[workflow values restore]', e && e.message); }
      const varsAtStart = store.size;

      const delegation = { count: 0, absorbedTokens: 0 }; // telemetry: isolation via sub-agents
      const recordDelegation = (result, label) => {
        recordDelegatedResult(delegation, taskLog, result, label);
      };
      const runDelegateTool = async (args) => {
        const result = await runOne(args && args.agent, args && args.task);
        const label = args && args.agent && args.agent !== 'auto' ? args.agent : 'general';
        recordDelegation(result, label);
        return { text: result.conclusion || '(sub-agent returned no conclusion)' };
      };
      const runAssignTool = async (args) => {
        const tasks = Array.isArray(args && args.tasks) ? args.tasks.filter((task) => task && task.task) : [];
        if (!tasks.length) return { text: 'assign: no tasks provided', isError: true };
        const results = await Promise.all(tasks.map(async (task) => {
          const result = await runOne(task.agent, task.task);
          recordDelegation(result, task.agent && task.agent !== 'auto' ? task.agent : String(task.task || '').slice(0, 60));
          return { agent: resolveDelegate(task.agent).agent.name, task: task.task, conclusion: result.conclusion || '' };
        }));
        if (args && args.merge) {
          const merged = await mergeResults({ connector, model: chosenModel, instruction: args.merge, results, onEvent: emitProgress });
          return { text: merged || '(merge produced nothing)' };
        }
        return { text: results.map((result, index) => `### Result ${index + 1} — ${result.agent}\n${result.conclusion}`).join('\n\n') };
      };
      const runCapturedTool = async (name, args) => {
        try { store.captureFromArgs(args, { source: name }); } catch {}
        const output = await rawCallTool(name, args);
        try { if (!output.isError) store.captureFromResult(name, output.text || ''); } catch {}
        try {
          for (const key of projectFacts.capture(store, { name, args, text: output.text || '', ok: !output.isError })) emitProgress({ type: 'process', kind: 'var-capture', key, from: 'project' });
        } catch {}
        return output;
      };
      const callTool = async (name, args) => {
        if (name === 'set_variable') {
          const entry = store.set({ key: args && args.key, value: args && args.value, type: args && args.type }, { confidence: 'derived', source: 'set_variable' });
          return { text: entry ? `Remembered ${entry.key} = ${JSON.stringify(entry.value)}` : 'Ignored (empty key or value).' };
        }
        if (name === 'save_document') {
          try { return await saveDocument(args || {}); }
          catch (e) { console.error('[save_document]', e && e.message); return { text: `save_document failed: ${e.message}`, isError: true }; }
        }
        if (name === 'delegate') return runDelegateTool(args);
        if (name === 'assign') return runAssignTool(args);
        return runCapturedTool(name, args);
      };
      return { authoredAgents, orchestratorTools, store, varsAtStart, callTool, runOne, delegation };
      }
      const { authoredAgents, orchestratorTools, store, varsAtStart, callTool, runOne, delegation } = await prepareTurnToolRuntime();

      async function executeTurnPipeline() {
      // Emit the pre-call context ledger so the INTERNALS tab can show exactly
      // what is occupying the window this turn (occupancy, compaction, prompt).
      function emitPreCallLedger() {
      try {
        const tokensBefore = estimateTokens(base);
        _e.sender.send('chat:progress', { turnId, ...buildLedger({ convo, tools: orchestratorTools, model: chosenModel, compressed, tokensBefore, skillSelect, toolScope }) });
      } catch (e) { console.error('[internals ledger]', e && e.message); }
      }

      // Interactive continuation: when the loop hits its tool-call budget, ask
      // the renderer (Continue / Stop) via the shared one-shot prompt queue.
      const onLimit = ({ iterations }) => askUser({ type: 'limit', iterations });

      let result;
      let planInfo = null; // {steps, replans, completed} — planner telemetry (v15)
      async function executeTurnPlan() {
        if (securityState.block) throw firewallError();
        // ── Plan Pass 2 (plan-derive.js): derive the steps from the loaded
        // skills + tools + known values. Only attempted when real capabilities
        // are in play; any planner failure degrades to {simple:true}, so the
        // flat loop below remains the worst case — planning can never make a
        // turn worse than today's behavior.
        // O15: the canonical project docs (spec/design/pseudocode/knowledge)
        // are the planner's source of truth for objective and purpose —
        // bootstrapped if missing (heals older projects), loaded here,
        // injected into every derive/refine call.
        function loadPlanningDocuments() {
          if (!projectId) return '';
          try {
            projectDocs.ensureCanonicalDocs({ projectId, docsBase }); projectDocs.backfillFiles({ projectId, outputDir });
            let block = projectDocs.load(projectId); const libraryList = projectDocs.listLibrary(projectId);
            if (libraryList) block += (block ? '\n\n' : '') + 'PROJECT LIBRARY (files on disk — read them with read_file at these paths; never ask the user where they are):\n' + libraryList;
            return block;
          } catch (error) { console.error('[project-docs load]', error && error.message); return ''; }
        }

        // Coding mode plans against REAL files: a depth-2 map of the working
        // dir feeds Pass 2 so steps name actual paths instead of guessing.
        async function loadRepositoryMap() {
          try {
            if (coding) return (await coding.call('list_dir', { depth: 2 })).text || '';
            if (library && project && project.working_dir) return (await library.call('list_dir', { path: project.working_dir, depth: 2 })).text || '';
          } catch {}
          return '';
        }
        const docsBlock = loadPlanningDocuments(); const repoMap = await loadRepositoryMap();

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
            let updated = 0;
            for (const t of ['design', 'pseudocode', 'knowledge']) {
              if (!upd[t]) continue;
              const w = projectDocs.writeCanonical({ projectId, docsBase, docType: t, content: upd[t], source: 'pipeline' });
              emitProgress({ type: 'process', kind: 'doc-update', doc: t, version: w.version });
              updated++;
            }
            return updated;
          } catch (e) { console.error('[doc-writer]', e && e.message); return 0; }
        };
        const turnMutated = didMutate;   // shared definition (coding-tools.js)
        // The files a trace actually changed, with content — evidence for the
        // review pass AND the doc-writer (documenting from step summaries
        // alone produced vague docs; real contents produce real module maps).
        const readChanged = async (trace) => {
          if (!coding) return [];
          const paths = [...new Set((trace || [])
            .filter((t) => t.ok !== false && WRITING_TOOLS.includes(t.name))
            .map((t) => (t.args && t.args.path) || '').filter(Boolean))].slice(0, 6);
          const files = [];
          for (const p of paths) {
            const r = await coding.call('read_file', { path: p });
            if (!r.isError) files.push({ path: p, content: String(r.text || '') });
          }
          return files;
        };
        // ── PRECONDITION GATE: a selected skill with none of its declared
        // tools reachable cannot do its job. Proceeding is not a degraded run,
        // it is a fabricated one — measured 2026-08-14, a dead Fluency
        // connector (401, zero of nine tools resolving) still produced a
        // formatted, filed, versioned monthly security report that was
        // invented end to end. Deterministic: no model call, no judgement,
        // just "you named tools that do not exist here". Partial resolution is
        // allowed; zero is the cliff.
        function unmetSkillPlan() {
          const unmet = loadedSkills.map((skill) => ({ name: skill.name, ...skillPreconditions(skill, toolset.tools.map((tool) => tool.name)) })).filter((item) => item.unmet);
          if (!unmet.length) return null;
          emitProgress({ type: 'process', kind: 'precondition-unmet', skills: unmet.map((skill) => ({ skill: skill.name, declared: skill.declared.length, missing: skill.missing })) });
          return { simple: true, align: true, goal: '', steps: [], record: [], droppedRecords: [], decisions: unmet.map((skill) => ({ question: `"${skill.name}" needs ${skill.declared.length} tool${skill.declared.length === 1 ? '' : 's'} that this project cannot reach right now (${skill.missing.slice(0, 4).join(', ')}${skill.missing.length > 4 ? `, +${skill.missing.length - 4} more` : ''}). How should I proceed?`, options: ['Reconnect the connector, then ask me again — the connector is probably disconnected or its authorization expired', 'Proceed anyway without live data — any figures would be unsourced'], recommendation: 'Reconnect first. A report assembled without its sources looks finished and is fiction, which is worse than no report.' })) };
        }
        async function deriveModelPlan() {
          if (!scopedTools.length && !loadedSkills.length) return null;
          emitProgress({ type: 'process', kind: 'planning', model: fastModel });
          const startedAt = Date.now();
          const derived = await Promise.race([
            derivePlan({ connector: { chat: chatAbortable }, model: fastModel, userText: plannerText, cheatSheet: [project && project.cheat_sheet, renderContract(workflowContract)].filter(Boolean).join('\n\n'), loadedSkills, tools: scopedTools, store, agents: authoredAgents, codingMode: !!coding, documentsMode: !!library, projectDocs: docsBlock, repoMap, rulebook: coding ? coding.rulebook : '', formatTarget, branding, rawData }),
            new Promise((resolve) => setTimeout(() => resolve({ simple: true, goal: '', steps: [], error: 'planning timed out (240s) — fell back to the flat loop' }), 240000))
          ]);
          if (derived.error) console.warn('[plan-derive]', derived.error);
          if (securityState.block) throw firewallError();
          emitProgress({ type: 'process', kind: 'planning-done', durationMs: Date.now() - startedAt, steps: derived.simple ? 0 : derived.steps.length, error: derived.error });
          taskLog.push({ kind: 'select', label: 'derive-plan', tokens: null, durationMs: Date.now() - startedAt, ok: !derived.error });
          return derived;
        }
        async function chooseTurnPlan() {
          if (workflowResume && workflowResume.plan && Array.isArray(workflowResume.plan.steps)) {
            emitProgress({ type: 'process', kind: 'planning-replay', runId: workflowResume.id, steps: workflowResume.plan.steps.length });
            return workflowResume.plan;
          }
          const missingScope = scopeAlignment(workflowContract);
          if (missingScope) { emitProgress({ type: 'process', kind: 'scope-required', issues: workflowContract.scope.issues.map((issue) => issue.key) }); return missingScope; }
          return unmetSkillPlan() || await deriveModelPlan();
        }
        function applyWorkflowResume(plan) {
          let resumed = constrainPlan(plan, workflowContract);
          if (!workflowResume || !workflowCheckpoints.length) return resumed;
          const before = resumed && Array.isArray(resumed.steps) ? resumed.steps.length : 0;
          const completed = workflowCheckpoints.filter((row) => !(row.result && row.result.incomplete)).length;
          resumed = resumePlan(resumed, workflowCheckpoints);
          resumed = focusResumedStockStep(resumed, workflowResume, workflowCheckpoints);
          emitProgress({ type: 'process', kind: 'workflow-resume-plan', runId: workflowResume.id, completed, partial: workflowCheckpoints.length - completed, remaining: resumed && resumed.steps ? resumed.steps.length : 0, removed: Math.max(0, before - ((resumed && resumed.steps && resumed.steps.length) || 0)) });
          return resumed;
        }
        function startWorkflowRun(plan) {
          if (!plan || (workflowContract.kind === 'generic' && (plan.simple || !plan.steps || !plan.steps.length))) return;
          try {
            workflowRun = workflowResume || repo.workflowRuns.start({ turnId, projectId: projectId || null, chatId, kind: workflowContract.kind, contract: { ...workflowContract, budgetExceeded: plan.budgetExceeded || null }, plan, state: store.toJSON() });
            if (workflowResume) repo.workflowRuns.updateStatus(workflowRun.id, 'running', { state: store.toJSON() });
            emitProgress({ type: 'process', kind: workflowResume ? 'workflow-resumed' : 'workflow-start', runId: workflowRun.id, workflow: workflowContract.kind });
          } catch (error) { console.error('[workflow start]', error && error.message); }
        }
        let plan = applyWorkflowResume(await chooseTurnPlan());
        startWorkflowRun(plan);

        // O8: decisions the user stated persist at `user` confidence — they
        // outrank model guesses and survive turns/restarts with the store.
        // O15: the same decisions land in the project SPEC as dated decision
        // records — deterministic bookkeeping, the doc twin of step-commits.
        // O8 + O14: report the DENOMINATOR, not just the rejections. A
        // dropped-only event made silence ambiguous — "nothing was proposed"
        // and "everything proposed was valid" looked identical, so a guard
        // that never ran was indistinguishable from one working perfectly.
        // This fires whenever the planner offered anything, so no event now
        // means exactly one thing: it offered nothing.
        function applyDocumentTargetRecord(record) {
          if (!projectId) return;
          if (record.key === 'document_branding') {
            repo.settings.set('output_branding', record.value, projectId);
            emitProgress({ type: 'process', kind: 'doc-target-set', target: 'branding' });
          } else if (record.key === 'document_format') {
            const fsx = require('node:fs'); const px = require('node:path');
            const directory = px.join(outputDir, 'formats');
            const formats = fsx.existsSync(directory) ? fsx.readdirSync(directory).filter((file) => file.toLowerCase().endsWith('.html')) : [];
            const wanted = String(record.value).toLowerCase();
            const match = formats.find((file) => file.toLowerCase().includes(wanted)) || (formats.length === 1 ? formats[0] : null);
            if (match) { repo.settings.set('output_format', px.join('formats', match), projectId); emitProgress({ type: 'process', kind: 'doc-target-set', target: 'format', value: match }); }
          } else if (record.key === 'document_rawdata') {
            repo.settings.set('output_rawdata', /^(1|true|yes|on)$/i.test(String(record.value)) ? '1' : '0', projectId);
            emitProgress({ type: 'process', kind: 'doc-target-set', target: 'rawdata' });
          }
        }
        function recordPlanDirections(plan) {
        const kept = (plan && Array.isArray(plan.record)) ? plan.record.length : 0;
        const dropped = (plan && Array.isArray(plan.droppedRecords)) ? plan.droppedRecords : [];
        if (kept + dropped.length > 0) {
          emitProgress({
            type: 'process', kind: 'records', proposed: kept + dropped.length,
            kept, dropped, reason: dropped.length ? 'not durable direction decisions' : ''
          });
        }
        // True only when this turn is the user answering the align form.
        const ratified = !!(payload && payload.fromAlign);
        if (plan && Array.isArray(plan.record) && plan.record.length) {
          for (const rec of plan.record) {
            // O8 tiering: `user` is the top, overwrite-protected tier and it
            // means THE HUMAN SAID THIS. Only a turn that answers the align
            // form qualifies (the renderer sets fromAlign on exactly that
            // turn). Everything else here is the planner's INFERENCE that a
            // direction was stated, so it lands at `derived` and stays
            // correctable — a wrong inference at `user` was permanent.
            const e = store.set({ key: rec.key, value: rec.value },
              ratified ? { confidence: 'user', source: 'align' } : { confidence: 'derived', source: 'plan-record' });
            if (e) emitProgress({ type: 'process', kind: 'var-set', key: e.key, confidence: e.confidence });
            // Chat ↔ Overview parity: DOCUMENT TARGETS stated in chat land in
            // the SAME per-project settings the Overview form shows. Format
            // values resolve against the library's formats/ files by name.
            try { applyDocumentTargetRecord(rec); } catch (e) { console.error('[doc-target-set]', e && e.message); }
          }
          if (projectId) {
            try {
              const w = projectDocs.appendDecisions({ projectId, docsBase, records: plan.record, goal: plan.goal || '' });
              if (w.added) emitProgress({ type: 'process', kind: 'doc-update', doc: 'spec', version: w.version, added: w.added });
            } catch (e) { console.error('[project-docs spec]', e && e.message); }
          }
        }
        }
        recordPlanDirections(plan);

        function finishAlignmentTurn(plan) {
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
        }
        async function executePlannedTurn(plan) {
          // ── Plan-and-execute path ─────────────────────────────────────────
          emitProgress({ type: 'process', kind: 'plan', goal: plan.goal, merge: plan.merge || '', orchestrator: plan.orchestrator || null, steps: plan.steps.map((s) => ({ id: s.id, task: s.task, produces: s.produces || '', parallel: s.parallel, group: s.group || '' })) });
          const planDeps = { connector: { chat: chatAbortable }, model: fastModel, userText: plannerText, cheatSheet: [project && project.cheat_sheet, renderContract(workflowContract)].filter(Boolean).join('\n\n'), loadedSkills, tools: scopedTools, agents: authoredAgents, projectDocs: docsBlock, repoMap, rulebook: coding ? coding.rulebook : '', formatTarget, branding, rawData };

          const onStuck = async ({ goal, stuckStep, values, replans }) =>
            ({ continue: (await askUser({ type: 'stuck', goal, step: stuckStep && stuckStep.task, values, replans })) > 0 });
          async function checkpointCompletedStep(step, stepResult, trace) {
            if (workflowRun) {
              try { repo.workflowRuns.checkpoint(workflowRun.id, { stepKey: step.id, step, result: stepResult, values: store.toJSON(), toolTrace: trace || [] }); emitProgress({ type: 'process', kind: 'checkpoint', runId: workflowRun.id, step: step.id }); }
              catch (error) { console.error('[workflow checkpoint]', error && error.message); }
            }
            if (!coding || !coding.gitAvailable || !didMutate(trace)) return;
            const message = `step ${step.id}: ${String(step.produces || step.task || '').slice(0, 150)}`;
            const committed = await commitStep(coding.root, message);
            if (committed.committed) emitProgress({ type: 'process', kind: 'step-commit', step: step.id, message });
          }
          async function compactPlannedHistory(history) {
            const output = await maybeCompress({ messages: history, contextWindow: contextWindowFor(chosenModel), protect: store.render() || undefined, summarize: async (older) => {
              const response = await chatAbortable({ model: fastModel, messages: [{ role: 'user', content: SUMMARY_PROMPT + renderForSummary(older) }], maxTokens: 700 });
              return response.text || '';
            } });
            if (output.compressed) emitProgress({ type: 'process', kind: 'mid-turn-compact', tokensBefore: output.tokensBefore });
            return output.messages;
          }
          async function mergePlannedGroup({ group, results }) {
            const orchestrator = (plan && plan.orchestrator) || {};
            const instruction = [orchestrator.merge || `Combine the results of the "${group}" tasks into one coherent digest. Preserve every named value verbatim; dedupe repeated facts; keep it complete but tight.`, orchestrator.on_conflict ? `On conflicting findings: ${orchestrator.on_conflict}` : ''].filter(Boolean).join('\n');
            emitProgress({ type: 'process', kind: 'group-merge', group, members: results.length, model: fastModel });
            return mergeResults({ connector: { chat: chatAbortable }, model: fastModel, instruction, results: results.map((item) => ({ agent: 'group', task: item.task, conclusion: item.conclusion })), onEvent: emitProgress });
          }
          async function runParallelPlanStep(step, parallelContext = {}) {
            const evidence = (Array.isArray(parallelContext.history) ? parallelContext.history : []).filter((message) => message && (message.role === 'assistant' || message.role === 'tool') && message.content).map((message) => `${String(message.role).toUpperCase()}${message.name ? ` (${message.name})` : ''}:\n${String(message.content)}`).join('\n\n').slice(-12000);
            const executableTask = expandParallelStepTask(step, plan.steps);
            const task = (store.render() ? store.render() + '\n\n' : '') + (evidence ? `SHARED PRIOR EVIDENCE (read-only; do not repeat its completed retrieval):\n${evidence}\n\n` : '') + executableTask + modeFlowSourceContext(workflowContract, repoMap) + (step.produces ? `\n\nTHIS TASK MUST PRODUCE: ${step.produces}` : '');
            const response = await runOne(step.agent, task);
            recordDelegatedResult(delegation, taskLog, response, step.agent && step.agent !== 'auto' ? step.agent : String(step.task || '').slice(0, 60));
            return { conclusion: response.conclusion || '', toolTrace: response.toolTrace || [] };
          }
          async function runDerivedPlan() {
            const refine = async (input) => {
              const refined = await refinePlan({ ...planDeps, ...input });
              return constrainPlan({ simple: false, steps: refined.steps || [] }, workflowContract, { remainingFrom: input.stuckStep && input.stuckStep.id });
            };
            return executePlan({ chat: workflowStepChat, callTool, model: chosenModel, plan, isAborted, tools: toolsForPlannedStep(orchestratorTools), store, history: convo, stepBudget: workflowContract.budgets.stepIterations, maxStepOutputTokens: effectiveStepOutputTokenBudget(workflowContract), maxStepDurationMs: effectiveStepDurationBudget(workflowContract), replanBudget: workflowContract.budgets.maxReplans, refinePlan: refine, onStuck, onStepComplete: checkpointCompletedStep, checkStep: (coding && coding.checkCommand) ? (step) => runTurnCheck('step', step) : undefined, checkCommand: coding ? coding.checkCommand : '', compact: compactPlannedHistory, mergeGroup: mergePlannedGroup, runParallel: runParallelPlanStep, onEvent: emitProgress });
          }
          const exec = await runDerivedPlan();

          // O26 third path: delegated/fan-out steps CAN mutate (sub-agents get
          // the coding tools) but their traces stay isolated, so the per-step
          // gate is blind to them. One final check covers whatever they did
          // to the tree — the deterministic verdict needs no trace.
          if (coding && coding.checkCommand && !exec.aborted && exec.stepResults.some((r) => r.parallel)) {
            try { await runTurnCheck('post-parallel'); } catch (e) { console.error('[check parallel]', e && e.message); }
          }

          // ── O11 verify layer 2+3: quality + security review of the changed
          // files (review.js), deterministic like step-commits. Layer 1 —
          // "it works" — is the plan's own verify step. Confirmed high/med
          // findings get ONE bounded fix step (worst first), then the fix is
          // committed; review can never spiral or break a turn.
          // O27: whatever this cycle cannot verify as fixed lands in the DEBT
          // ledger afterwards — nothing evaporates.
          function mergeExecutionUsage(extra) {
            if (!extra || !extra.calls) return;
            exec.usage.measured = exec.usage.measured || extra.measured; exec.usage.calls += extra.calls;
            exec.usage.inputTokens += extra.inputTokens; exec.usage.outputTokens += extra.outputTokens;
            exec.usage.cachedTokens += extra.cachedTokens; exec.usage.cacheCreationTokens += extra.cacheCreationTokens;
          }
          async function fixReviewFindings(findings) {
            const fixStep = { id: exec.stepResults.length + 1, task: 'Code review found problems in the files you just changed. Fix each one, then re-run the project tests to confirm nothing broke:\n' + findings.map((finding) => `- [${finding.lens}/${finding.severity}] ${finding.file}: ${finding.issue}${finding.fix ? ` — fix: ${finding.fix}` : ''}`).join('\n'), produces: 'review findings fixed, tests passing' };
            const fix = await executeStep({ chat: workflowStepChat, callTool, model: chosenModel, step: fixStep, tools: toolsForPlannedStep(orchestratorTools), history: exec.history, store, onEvent: emitProgress, isAborted });
            exec.stepResults.push(fix.result); exec.toolTrace.push(...(fix.toolTrace || [])); mergeExecutionUsage(fix.usage);
            try {
              const commit = await commitStep(project.working_dir, 'review: fix quality/security findings');
              if (commit && commit.committed) emitProgress({ type: 'process', kind: 'step-commit', step: 'review' });
            } catch {}
            await runTurnCheck('post-fix');
            const verified = reviewRepairVerified(fix.result, !!coding.checkCommand, checkState);
            emitProgress({ type: 'process', kind: verified ? 'review-fixed' : 'review-partial', count: findings.length });
            return findings.map((finding) => ({ ...finding, status: verified ? 'fixed' : 'fix attempted — unverified' }));
          }
          async function reviewPlannedExecution() {
            if (!coding || exec.aborted || !exec.completed || !turnMutated(exec.toolTrace)) return [];
            try {
              const files = await readChanged(exec.toolTrace); if (!files.length) return [];
              emitProgress({ type: 'process', kind: 'review', files: files.length });
              const review = await reviewChanges({ connector: { chat: chatAbortable }, model: fastModel, files, goal: plan.goal });
              if (checkState.ran && checkState.failing) review.findings.unshift({ lens: 'check', severity: 'high', file: '(project)', issue: `the project check command (${coding.checkCommand}) is failing`, fix: 'make it pass by fixing the root cause — never by weakening tests' });
              if (review.findings.length && !isAborted()) { emitProgress({ type: 'process', kind: 'review-findings', count: review.findings.length }); return fixReviewFindings(review.findings); }
              emitProgress({ type: 'process', kind: 'review-clean' }); return [];
            } catch (error) { console.error('[review]', error && error.message); return []; }
          }
          let turnFindings = await reviewPlannedExecution();

          async function verifyStockFramework() {
            if (workflowContract.kind !== 'stock-analysis' || !coding || !projectId || exec.aborted) return { primarySourceVerification: null, frameworkHostStatus: null };
            emitProgress({ type: 'process', kind: 'framework-verification-start' });
            const [primarySourceVerification, frameworkHostStatus] = await Promise.all([
              verifyPrimarySources({ root: coding.root }).catch((error) => ({ ok: false, valid: [], checked: [], detail: `primary-source verification failed: ${error.message}` })),
              ensureStockHost({ projectId, root: coding.root }).catch((error) => ({ running: false, verified: false, frameworkOwned: true, verifiedPaths: [], error: error.message }))
            ]);
            emitProgress({ type: 'process', kind: 'framework-verification-done', primarySources: primarySourceVerification.valid.length, hosted: !!frameworkHostStatus.verified });
            return { primarySourceVerification, frameworkHostStatus };
          }
          const { primarySourceVerification, frameworkHostStatus } = await verifyStockFramework();

          // Plan attrition reaches the reply. A re-plan may legitimately drop
          // steps, but the user should never be told a 4-step plan succeeded
          // when 2 of its steps never ran — that is how a turn that produced
          // nothing reported success.
          exec.stepResults.push(...planStatusResults(exec));

          // Runtime acceptance gate: inspect what actually ran and what was
          // actually saved. Prompt instructions can be ignored; these checks
          // cannot. One bounded repair is allowed, then any remaining failure
          // is carried into synthesis as an incomplete result.
          const acceptanceContext = () => {
            const linked = chatId ? repo.documents.listByChat(chatId) : [];
            const changedDocs = linked.filter((d) => {
              const before = artifactBaseline.get(d.id);
              return !before || Number(before.version) !== Number(d.version) || before.updated_at !== d.updated_at;
            });
            const changedPaths = [...new Set((exec.toolTrace || [])
              .filter((t) => t && t.ok !== false && WRITING_TOOLS.includes(t.name) && t.args && t.args.path)
              .map((t) => String(t.args.path)))];
            return {
              stepResults: exec.stepResults,
              caseIds: Array.from({ length: Number(workflowContract.scope && workflowContract.scope.count) || 5 }, (_unused, index) => store.get(`top_case_${index + 1}_id`)).filter(Boolean),
              artifacts: [...changedDocs, ...changedPaths.map((p) => ({ path: path.isAbsolute(p) ? p : (coding ? path.join(coding.root, p) : p), title: path.basename(p) }))],
              toolTrace: [...(exec.toolTrace || []), ...(exec.delegatedToolTrace || [])],
              check: { ran: checkState.ran, ok: !checkState.failing },
              checkRequired: !!(coding && coding.checkCommand),
              workingDir: coding ? coding.root : null,
              primarySourceVerification,
              serverStatus: frameworkHostStatus || (coding && projectId ? devServer.status(projectId) : null)
            };
          };
          async function repairAcceptanceFailures(acceptanceContext) {
            const repairStep = { id: 'acceptance-repair', task: 'The deterministic acceptance gate found these exact gaps:\n' + workflowAcceptance.failures.map((failure) => `- ${failure.id}: ${failure.detail}`).join('\n') + '\nCorrect only these gaps, reuse evidence already collected, and verify the result. Do not broaden scope.', produces: 'all failed acceptance checks corrected' };
            emitProgress({ type: 'process', kind: 'acceptance-repair', failures: workflowAcceptance.failures.map((failure) => failure.id) });
            const repair = await executeStep({ chat: workflowStepChat, callTool, model: chosenModel, step: repairStep, tools: toolsForPlannedStep(orchestratorTools), history: exec.history, store, maxTokens: effectiveStepOutputTokenBudget(workflowContract), onEvent: emitProgress, isAborted });
            exec.stepResults.push(repair.result); exec.toolTrace.push(...(repair.toolTrace || [])); mergeExecutionUsage(repair.usage);
            if (workflowRun) { try { repo.workflowRuns.checkpoint(workflowRun.id, { stepKey: repairStep.id, step: repairStep, result: repair.result, values: store.toJSON(), toolTrace: repair.toolTrace || [] }); } catch {} }
            if (coding && coding.checkCommand && didMutate(repair.toolTrace || [])) await runTurnCheck('acceptance-repair');
            workflowAcceptance = validateWorkflow({ ...workflowContract, budgetExceeded: plan.budgetExceeded || null }, acceptanceContext());
            emitProgress({ type: 'process', kind: workflowAcceptance.ok ? 'acceptance-pass' : 'acceptance-failed', repaired: true, checks: workflowAcceptance.checks });
          }
          async function validateExecutionAcceptance(acceptanceContext) {
            if (exec.aborted) return;
            workflowAcceptance = validateWorkflow({ ...workflowContract, budgetExceeded: plan.budgetExceeded || null }, acceptanceContext());
            emitProgress({ type: 'process', kind: workflowAcceptance.ok ? 'acceptance-pass' : 'acceptance-failed', checks: workflowAcceptance.checks });
            if (shouldRepairAcceptance(exec, workflowContract, workflowAcceptance) && !isAborted()) await repairAcceptanceFailures(acceptanceContext);
            if (!workflowAcceptance.ok) exec.stepResults.push({ step: 'acceptance', task: 'workflow acceptance checks', incomplete: true, conclusion: 'The workflow is partial. Remaining gaps:\n' + workflowAcceptance.failures.map((failure) => `- ${failure.id}: ${failure.detail}`).join('\n') });
          }
          await validateExecutionAcceptance(acceptanceContext);

          // O26: a check still failing after everything is an honest,
          // visible outcome — it reaches synthesis as an incomplete step
          // result, so the reply says what remains instead of claiming done.
          function recordEndOfTurnFindings() {
            if (checkState.ran && checkState.failing && !exec.aborted) {
              exec.stepResults.push({ step: 'check', task: `project check (${coding.checkCommand})`, conclusion: 'FAILING at turn end:\n' + checkState.output, incomplete: true });
              if (!turnFindings.some((finding) => finding.lens === 'check')) turnFindings.push({ lens: 'check', severity: 'high', file: '(project)', issue: `check command (${coding.checkCommand}) failing at turn end`, fix: 'fix the root cause', status: 'unresolved' });
            }
            if (!turnFindings.length || !projectId) return;
            try {
              const debt = projectDocs.appendDebt({ projectId, docsBase, findings: turnFindings });
              if (debt.added) emitProgress({ type: 'process', kind: 'debt', added: debt.added, repeats: debt.repeats, version: debt.version });
            } catch (error) { console.error('[debt]', error && error.message); }
          }

          // The bubble has been streaming per-step text; the synthesis is the
          // REAL reply — tell the renderer to start its buffer fresh so the
          // final message isn't a concatenation of every step's conclusion.
          // On a user STOP there is no synthesis call: assemble the save-work
          // reply from what the steps concluded, with zero further model time.
          async function synthesizePlannedExecution() {
            emitProgress({ type: 'stream-reset' });
            if (exec.aborted) {
              const digest = exec.stepResults.map((step) => `### Step ${step.step}: ${step.task}${step.incomplete ? ' (incomplete)' : ''}\n${step.conclusion || '(no result)'}`).join('\n\n');
              return { reply: '⏹ Stopped at your request — work so far was saved (values remembered, completed steps below).\n\n' + (digest || '(stopped before any step completed)'), usage: null };
            }
            if (['provider-timeout', 'provider-budget-exhausted'].includes(exec.terminalReason)) {
            emitProgress({ type: 'process', kind: 'synthesis-skipped', reason: 'provider-timeout' });
              return { reply: renderProviderPausedReply(exec.stepResults), usage: null };
            }
            return synthesize({ chat: chatAbortable, model: chosenModel, plan, stepResults: exec.stepResults, store, history: exec.history, onEvent: emitProgress });
          }
          function mergeSynthesisUsage(synthesis) {
          const u = exec.usage || { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0, measured: false };
            if (synthesis.usage) {
            u.measured = true; u.calls += 1;
              u.inputTokens += synthesis.usage.inputTokens || 0; u.outputTokens += synthesis.usage.outputTokens || 0;
              u.cachedTokens += synthesis.usage.cachedTokens || 0; u.cacheCreationTokens += synthesis.usage.cacheCreationTokens || 0;
            }
            return u;
          }
          async function maintainPlannedDocumentation() {
            if (!coding || exec.aborted || !projectId || !turnMutated(exec.toolTrace)) return;
            const updated = await maintainDocs({ goal: plan.goal, stepResults: exec.stepResults, toolTrace: exec.toolTrace });
            if (updated && coding.gitAvailable) {
              const commit = await commitStep(coding.root, 'docs: maintain project documentation');
              if (commit && commit.committed) emitProgress({ type: 'process', kind: 'step-commit', step: 'docs' });
            }
          }
          recordEndOfTurnFindings();
          const syn = await synthesizePlannedExecution(); const u = mergeSynthesisUsage(syn);
          emitProgress({ type: 'done' });
          result = { reply: syn.reply, toolTrace: exec.toolTrace, iterations: exec.stepResults.length, usage: u, planned: true, cappedTurn: !exec.completed || !!(workflowAcceptance && !workflowAcceptance.ok), aborted: exec.aborted, truncated: !!(exec.truncated || syn.truncated), checkFailing: !!(checkState.ran && checkState.failing && !exec.aborted), checkCommand: coding ? coding.checkCommand : '', acceptance: workflowAcceptance };
          planInfo = { steps: plan.steps.length, replans: exec.replans, completed: exec.completed && (!workflowAcceptance || workflowAcceptance.ok) };

          // O15: documentation is maintained AUTOMATICALLY after execution —
          // a dedicated technical-writer pass (doc-writer.js), deterministic
          // like step-commits and decision records. Plan-step documentation
          // produced untouched skeletons and narrative sludge; this doesn't.
          await maintainPlannedDocumentation();
        }
        async function executeFlatTurn() {
          async function compactFlatHistory(history) {
            const output = await maybeCompress({ messages: history, contextWindow: contextWindowFor(chosenModel), protect: store.render() || undefined, summarize: async (older) => {
              const response = await chatAbortable({ model: fastModel, messages: [{ role: 'user', content: SUMMARY_PROMPT + renderForSummary(older) }], maxTokens: 700 });
              return response.text || '';
            } });
            if (output.compressed) emitProgress({ type: 'process', kind: 'mid-turn-compact', tokensBefore: output.tokensBefore });
            return output.messages;
          }
          async function repairFlatCheck() {
            const check = await runTurnCheck('turn');
            if (!check || check.ok || isAborted()) return;
            const fixStep = { id: 1, task: 'The project check command FAILED after your changes:\n' + check.output + '\nFix the ROOT CAUSE so the check passes. NEVER delete, skip, or weaken a failing test to reach green; if a test itself is wrong, say so explicitly.', produces: 'the project check command passing' };
            const fix = await executeStep({ chat: chatAbortable, callTool, model: chosenModel, step: fixStep, tools: toolsForPlannedStep(orchestratorTools), history: convo, store, onEvent: emitProgress, isAborted });
            result.toolTrace.push(...(fix.toolTrace || [])); await runTurnCheck('post-fix');
            if (!checkState.failing) return;
            try {
              const debt = projectDocs.appendDebt({ projectId, docsBase, findings: [{ lens: 'check', severity: 'high', file: '(project)', issue: `check command (${coding.checkCommand}) failing at turn end`, fix: 'fix the root cause', status: 'unresolved' }] });
              if (debt.added) emitProgress({ type: 'process', kind: 'debt', added: debt.added, repeats: debt.repeats, version: debt.version });
            } catch (error) { console.error('[debt]', error && error.message); }
          }
          async function recordFlatCodingWork() {
            try { await repairFlatCheck(); } catch (error) { console.error('[flat check]', error && error.message); }
            if (checkState.ran && checkState.failing) { result.checkFailing = true; result.checkCommand = coding.checkCommand; }
            try {
              const commit = await commitStep(project.working_dir, `turn: ${String(text).slice(0, 150)}`);
              if (commit && commit.committed) emitProgress({ type: 'process', kind: 'step-commit', step: 'turn' });
            } catch (error) { console.error('[flat commit]', error && error.message); }
            const updated = await maintainDocs({ goal: text, stepResults: [], toolTrace: result.toolTrace });
            if (updated && coding.gitAvailable) {
              const commit = await commitStep(coding.root, 'docs: maintain project documentation');
              if (commit && commit.committed) emitProgress({ type: 'process', kind: 'step-commit', step: 'docs' });
            }
          }
          const knownBlock = store.render();
          result = await runChatLoop({
            chat: chatAbortable,
            callTool,
            model: chosenModel,
            messages: knownBlock ? [{ role: 'system', content: knownBlock }, ...convo] : convo,
            tools: orchestratorTools,
            onEvent: emitProgress,
            onLimit,
            isAborted,
            // In-loop ledger for the flat path — tool results accrete inside
            // the loop; the pre-turn compress alone can't defend the window.
            compact: compactFlatHistory
          });
          if (result.aborted && !result.reply) result.reply = '⏹ Stopped at your request — the work above was kept.';
          if (coding && !result.aborted && projectId && turnMutated(result.toolTrace)) await recordFlatCodingWork();
        }
        if (plan && plan.align && plan.decisions && plan.decisions.length) finishAlignmentTurn(plan);
        else if (plan && !plan.simple && plan.steps.length > 1) await executePlannedTurn(plan);
        else await executeFlatTurn();
      }
      function recordFirewallFailure(error) {
          emitProgress({ type: 'security', ...securityState.block });
          emitProgress({ type: 'done' });
          // Keep the work the turn had already done. A blocked investigation
          // that made eleven MCP calls before the guard fired still has eleven
          // tool results worth of evidence, and the audit/metrics rows are the
          // only place that survives — reporting toolTrace:[] and iterations:0
          // made every block look like it happened on the first call.
          const partial = (error.partial && typeof error.partial === 'object') ? error.partial : {};
          result = {
            reply: securityState.block.message,
            toolTrace: partial.toolTrace || [],
            iterations: partial.iterations || 0,
            // The AGGREGATE, plus the refused call. `firewallUsage` alone is
            // just the blocked response — a handful of tokens — so reporting it
            // for a turn that had already spent eleven model calls billed the
            // user's telemetry for a fraction of what the turn actually cost.
            usage: mergeBlockedUsage(partial.usage, securityState.usage),
            planned: false, firewallBlocked: true, security: securityState.block
          };
          planInfo = { steps: 0, replans: 0, completed: false };
      }
      function rethrowProviderFailure(error) {
          console.error(`[chat] ${provider.type}/${chosenModel} error (${orchestratorTools.length} tools):`, error && error.message);
          // The normal status finalizer below is unreachable when the handler
          // rethrows. Persist the failure here so a crashed provider/tool turn
          // never leaves a workflow permanently marked "running" after the
          // app has already returned an error to the caller.
          if (workflowRun) {
            try {
              repo.workflowRuns.updateStatus(workflowRun.id, 'partial', { state: store.toJSON(), error: String((error && error.message) || 'turn failed').slice(0, 1000) });
              emitProgress({ type: 'process', kind: 'workflow-status', runId: workflowRun.id, status: 'partial' });
            } catch (statusError) { console.error('[workflow failure status]', statusError && statusError.message); }
          }
          throw error;
      }
      function handleTurnFailure(error) {
        if (error && error.code === 'LLM_GUARD_BLOCKED' && securityState.block) recordFirewallFailure(error);
        else rethrowProviderFailure(error);
      }
      emitPreCallLedger();
      try {
        await executeTurnPlan();
      } catch (error) {
        handleTurnFailure(error);
      } finally {
        ipcMain.removeListener('chat:continue', promptListener);
        ipcMain.removeListener('chat:abort', abortListener);
      }
      return { result, planInfo };
      }
      const { result, planInfo } = await executeTurnPipeline();
      function finalizeWorkflowStatus() {
        if (!workflowRun) return;
        const accepted = workflowAcceptance ? workflowAcceptance.ok : !!(planInfo && planInfo.completed && result && !result.aligned && !result.aborted && !result.firewallBlocked);
        const status = accepted ? 'completed' : 'partial';
        const error = status === 'partial' && workflowAcceptance && workflowAcceptance.failures.length ? workflowAcceptance.failures.map((failure) => `${failure.id}: ${failure.detail}`).join('; ') : undefined;
        repo.workflowRuns.updateStatus(workflowRun.id, status, { state: store.toJSON(), error });
        emitProgress({ type: 'process', kind: 'workflow-status', runId: workflowRun.id, status });
      }
      function persistTurnVariables() {
        if (chatId) repo.chats.setVariables(chatId, store.size ? JSON.stringify(store.toJSON()) : null);
      }
      function emitInternalsToolTrace() {
        const trace = (result.toolTrace || []).map((tool) => {
          const rawTokens = Math.ceil((tool.resultChars || 0) / 4);
          const resultTokens = Math.ceil((tool.filteredChars != null ? tool.filteredChars : tool.resultChars || 0) / 4);
          return { name: tool.name, rawTokens, resultTokens, saved: Math.max(0, rawTokens - resultTokens), rules: tool.rules || [], truncated: !!tool.truncated, isError: tool.ok === false };
        });
        if (trace.length) _e.sender.send('chat:progress', { turnId, type: 'internals-tools', trace });
      }
      function buildTurnMetricRow() {
        const est = estimateTokens(convo);
        const filterSaved = (result.toolTrace || []).reduce((saved, tool) => {
          const raw = tool.resultChars || 0; const after = tool.filteredChars != null ? tool.filteredChars : raw;
          return saved + Math.max(0, raw - after) / 4;
        }, 0);
        const compactionSaved = compressed ? Math.max(0, estimateTokens(base) - est) : 0;
        const usage = result.usage || {};
        return {
          projectId: projectId || null, chatId: payload?.chatId || null, model: chosenModel,
          measured: !!usage.measured, inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0, cachedTokens: usage.cachedTokens || 0,
          cacheCreationTokens: usage.cacheCreationTokens || 0,
          estInputTokens: est, window: contextWindowFor(chosenModel),
          skillsAvailable: skillSelect ? skillSelect.available : 0, skillsLoaded: skillSelect ? (skillSelect.selected || []).length : 0,
          skillSavedTokens: skillSelect ? (skillSelect.savedTokens || 0) : 0, skillsUsed: skillSelect ? (skillSelect.selected || []) : [],
          filterSavedTokens: Math.round(filterSaved), compactionSavedTokens: compactionSaved,
          delegated: delegation.count, delegateAbsorbedTokens: delegation.absorbedTokens, durationMs: Date.now() - turnStart,
          // Makes the planner's fallback rate queryable across turns instead
          // of only visible one turn at a time in the INTERNALS tab.
          planningFailed: !!(skillSelect && skillSelect.error), toolFellBack: !!(toolScope && toolScope.fellBack),
          // v15: measure the planner itself.
          planSteps: planInfo ? planInfo.steps : 0, planRefines: planInfo ? planInfo.replans : 0,
          varsCaptured: Math.max(0, store.size - varsAtStart)
        };
      }
      function emitCostOutlier(metricRow) {
        try {
          const prior = repo.metrics.listByProject(projectId, 20).filter((metric) => metric.measured && metric.input_tokens > 0);
          const median = medianOf(prior.map((metric) => metric.input_tokens));
          if (median && metricRow.inputTokens > median * COST_OUTLIER_FACTOR) {
            emitProgress({ type: 'process', kind: 'cost-outlier', inputTokens: metricRow.inputTokens, median, factor: +(metricRow.inputTokens / median).toFixed(1), replans: metricRow.planRefines, steps: metricRow.planSteps });
          }
        } catch (error) { console.error('[cost outlier]', error && error.message); }
      }
      function recordTurnMetrics() {
        const metricRow = buildTurnMetricRow(); emitCostOutlier(metricRow);
        repo.metrics.record(metricRow);
        for (const tool of (result.toolTrace || [])) {
          taskLog.push({ kind: 'tool', label: tool.name, tokens: Math.ceil((tool.filteredChars != null ? tool.filteredChars : tool.resultChars || 0) / 4), durationMs: tool.durationMs, ok: tool.ok !== false });
        }
        try { repo.metrics.recordTasks(taskLog.map((task) => ({ ...task, projectId: projectId || null, chatId: payload?.chatId || null }))); } catch (error) { console.error('[task metrics]', error && error.message); }
        const cachePct = metricRow.inputTokens ? Math.round((metricRow.cachedTokens / metricRow.inputTokens) * 100) : 0;
        console.log('[metrics]', JSON.stringify({ measured: metricRow.measured, model: metricRow.model, input: metricRow.inputTokens, output: metricRow.outputTokens, cached: metricRow.cachedTokens, cachePct, est: metricRow.estInputTokens, filterSaved: metricRow.filterSavedTokens, skillSaved: metricRow.skillSavedTokens, delegated: metricRow.delegated, durationMs: metricRow.durationMs, tasks: taskLog.length, planningFailed: metricRow.planningFailed, toolFellBack: metricRow.toolFellBack }));
        _e.sender.send('chat:progress', { turnId, type: 'metrics', ...metricRow, tasks: taskLog });
      }
      async function fileCompletedSession() {
        const chat = repo.chats.get(chatId);
        const messages = [...repo.messages.listByChat(chatId), { role: 'assistant', content: String(result.reply || '').slice(0, 2000) }];
        const filed = await librarian.fileSession({ connector, model: fastModel, messages, currentTitle: (chat && chat.title) || '', vocabulary: buildVocabulary(projectId) });
        if (filed.summary) repo.chats.setSummary(chatId, filed.summary);
        if (filed.title && !(chat && chat.title)) repo.chats.rename(chatId, filed.title);
        tagFiledItem(projectId, chatId, 'chat', filed.tags || []);
        try { _e.sender.send('librarian:update', { chatId, projectId, titled: !!(filed.title && !(chat && chat.title)), summarized: !!filed.summary, tags: (filed.tags || []).length }); } catch {}
      }
      try { finalizeWorkflowStatus(); } catch (error) { console.error('[workflow status]', error && error.message); }
      try { persistTurnVariables(); } catch (error) { console.error('[variables save]', error && error.message); }
      try { emitInternalsToolTrace(); } catch (error) { console.error('[internals tools]', error && error.message); }
      try { recordTurnMetrics(); } catch (error) { console.error('[metrics]', error && error.message); }
      if (chatId && projectId && !result.aborted && !result.firewallBlocked) fileCompletedSession().catch((error) => console.error('[librarian:session]', error && error.message));

      return { model: chosenModel, reply: result.reply, provider: provider.type, toolTrace: result.toolTrace, compressed, usage: result.usage || null, planned: !!result.planned, aborted: !!result.aborted, truncated: !!result.truncated, firewallBlocked: !!result.firewallBlocked, security: result.security || null, acceptance: result.acceptance || null };
    }

    if (!providerId) throw new Error('No model selected for this chat. Choose a model before sending.');
    return runProviderTurn();
  });
}

function registerIpc() {
  registerProjectHandlers();
  registerDocumentFileHandlers();
  registerAgentMetricSettingsHandlers();
  registerChatMessageHandlers();
  registerDocumentLibraryHandlers();
  registerLibrarianHandlers();
  registerSkillHandlers();
  registerProviderHandlers();
  registerGuardHandlers();
  registerMcpHandlers();
  registerChatExecutionHandler();
}

// medianOf gates the cost-outlier signal and had no coverage — it silently
// returns 0 below MIN_COST_HISTORY, which is exactly why the signal never
// fired during testing (every drive created a fresh project with no history).
module.exports = { registerIpc, documentPathAllowed, medianOf, toolsForPlannedStep, reviewRepairVerified, recordDelegatedResult, expandParallelStepTask, modeFlowSourceContext, COST_OUTLIER_FACTOR, MIN_COST_HISTORY };
