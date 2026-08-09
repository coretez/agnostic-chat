'use strict';

window.addEventListener('error', (e) => console.error('[window.error]', e.message, `${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => console.error('[unhandledrejection]', e.reason && (e.reason.stack || e.reason.message || String(e.reason))));
console.log('[boot] renderer start, window.api =', typeof window.api);

const $ = (id) => document.getElementById(id);
const el = {
  html: document.documentElement,
  tbName: $('titlebar-name'), tbSlug: $('titlebar-slug'),
  model: $('model'), modelBtn: $('model-btn'), modelMenu: $('model-menu'), modelLabel: $('model-label'),
  modelSwitch: $('model-switch'),
  ovPrefDd: $('ov-pref-dd'), ovPrefBtn: $('ov-pref-btn'), ovPrefLabel: $('ov-pref-label'), ovPrefMenu: $('ov-pref-menu'),
  ovFastDd: $('ov-fast-dd'), ovFastBtn: $('ov-fast-btn'), ovFastLabel: $('ov-fast-label'), ovFastMenu: $('ov-fast-menu'),
  themeBtn: $('theme-btn'), paletteBtn: $('palette-btn'), modelsBtn: $('models-btn'),
  projectList: $('project-list'), chatList: $('chat-list'),
  newProjectBtn: $('new-project-btn'), newProjectForm: $('new-project-form'), newProjectInput: $('new-project-input'),
  ovName: $('ov-name'), ovWdPath: $('ov-wd-path'), ovWdChange: $('ov-wd-change'), ovWdReveal: $('ov-wd-reveal'),
  ovOutPath: $('ov-out-path'), ovOutChange: $('ov-out-change'), ovOutReveal: $('ov-out-reveal'),
  ovModel: $('ov-model'), ovChats: $('ov-chats'), ovDocs: $('ov-docs'), ovSkills: $('ov-skills'), ovMcp: $('ov-mcp'),
  ovCheat: $('ov-cheat'), ovCheatSave: $('ov-cheat-save'), ovCheatMsg: $('ov-cheat-msg'),
  heroNewProject: $('hero-new-project'), newChatBtn: $('new-chat-btn'),
  tabbar: $('tabbar'), toolbarNote: $('toolbar-note'), pages: $('pages'),
  messages: $('messages'), input: $('input'), send: $('send'), composerScope: $('composer-scope'), modeWork: $('mode-work'), modeDocs: $('mode-documents'), modeCode: $('mode-code'), bypassChip: $('bypass-chip'),
  ctxMeter: $('ctx-meter'),
  intModel: $('int-model'), intEmpty: $('int-empty'), intBody: $('int-body'), intWindow: $('int-window'),
  intOccbar: $('int-occbar'), intLegend: $('int-legend'), intTimeline: $('int-timeline'),
  intMsgcount: $('int-msgcount'), intPrompt: $('int-prompt'),
  intMeasuredCard: $('int-measured-card'), intMeasured: $('int-measured'), intMeasuredSrc: $('int-measured-src'),
  intLenstabs: $('int-lenstabs'), intContext: $('int-context'), intProcess: $('int-process'),
  intStages: $('int-stages'), intThreads: $('int-threads'), intThreadmeta: $('int-threadmeta'),
  intReview: $('int-review'), intEvalDd: $('int-eval-dd'), intEvalBtn: $('int-eval-btn'), intEvalLabel: $('int-eval-label'),
  intEvalMenu: $('int-eval-menu'), intEvalRun: $('int-eval-run'), intEvalNote: $('int-eval-note'),
  intEvalAssessment: $('int-eval-assessment'), intEvalFindings: $('int-eval-findings'),
  attachBtn: $('attach-btn'), attachInput: $('attach-input'), attachDirBtn: $('attach-dir-btn'), attachDirInput: $('attach-dir-input'), composerAttach: $('composer-attach'),
  railTabs: $('rail-tabs'), railDocList: $('rail-doc-list'), railAddDoc: $('rail-add-doc'),
  scopeSkillsHead: $('scope-skills-head'), scopeSkillsNote: $('scope-skills-note'),
  palette: $('palette'), paletteInput: $('palette-input'), paletteList: $('palette-list'),
  // Models screen
  connList: $('conn-list'), connEmpty: $('conn-empty'), connEditor: $('conn-editor'), editorTitle: $('editor-title'),
  typeDd: $('type-dd'), typeBtn: $('type-btn'), typeLabel: $('type-label'), typeMenu: $('type-menu'),
  fLabel: $('f-label'), fBaseurl: $('f-baseurl'), fSecret: $('f-secret'), fSecretHint: $('f-secret-hint'),
  modelDd: $('model-dd'), fModel: $('f-model'), fModelMenu: $('f-model-menu'),
  fastModelDd: $('fast-model-dd'), fFastModel: $('f-fast-model'), fFastModelMenu: $('f-fast-model-menu'),
  connAdd: $('conn-add'), connTest: $('conn-test'), testResult: $('test-result'),
  connCancel: $('conn-cancel'), connSave: $('conn-save'), modelsDone: $('models-done'),
  modelsHelp: $('models-help'), keyHelp: $('key-help'),
  help: $('help'), helpTitle: $('help-title'), helpBody: $('help-body'), helpClose: $('help-close'),
  // MCP
  mcpBtn: $('mcp-btn'),
  mcpList: $('mcp-list'), mcpEmpty: $('mcp-empty'), mcpEditor: $('mcp-editor'), mcpEditorTitle: $('mcp-editor-title'),
  mName: $('m-name'),
  mTransportDd: $('m-transport-dd'), mTransportBtn: $('m-transport-btn'), mTransportLabel: $('m-transport-label'), mTransportMenu: $('m-transport-menu'),
  mStdioFields: $('m-stdio-fields'), mHttpFields: $('m-http-fields'),
  mCommand: $('m-command'), mArgs: $('m-args'), mEnv: $('m-env'), mUrl: $('m-url'), mToken: $('m-token'),
  mcpAdd: $('mcp-add'), mcpConnect: $('mcp-connect'), mcpResult: $('mcp-result'), mcpCancel: $('mcp-cancel'), mcpSave: $('mcp-save'), mcpDone: $('mcp-done'),
  scopeMcpHead: $('scope-mcp-head'), scopeMcpList: $('scope-mcp-list'), scopeMcpNote: $('scope-mcp-note'), scopeMcpAdd: $('scope-mcp-add'),
  planList: $('plan-list'), planElapsed: $('plan-elapsed'), planNote: $('plan-note'),
  scopeSkillsManage: $('scope-skills-manage'),
  // Skills page
  skillList: $('skill-list'), skillEmpty: $('skill-empty'), skillsMsg: $('skills-msg'),
  skillsImport: $('skills-import'), skillAdd: $('skill-add'),
  skillsSrcDd: $('skills-src-dd'), skillsSrcBtn: $('skills-src-btn'), skillsSrcLabel: $('skills-src-label'), skillsSrcMenu: $('skills-src-menu'),
  skillEditor: $('skill-editor'), skillEditorTitle: $('skill-editor-title'),
  sName: $('s-name'), sDesc: $('s-desc'), sDef: $('s-def'), sTools: $('s-tools'),
  skillCancel: $('skill-cancel'), skillSave: $('skill-save'),
  agentAdd: $('agent-add'), agentsMsg: $('agents-msg'), agentList: $('agent-list'), agentEmpty: $('agent-empty'),
  agentEditor: $('agent-editor'), agentEditorTitle: $('agent-editor-title'),
  aName: $('a-name'), aDesc: $('a-desc'), aPrompt: $('a-prompt'), aModel: $('a-model'), aTools: $('a-tools'),
  agentCancel: $('agent-cancel'), agentSave: $('agent-save')
};

const state = {
  theme: 'light',
  selected: null,           // { providerId, model }
  page: 'chat',
  projects: [], currentProjectId: null,
  chats: [], currentChatId: null,
  documents: [], skills: [], attachments: [],
  internals: {},            // chatId -> { ledger, toolTurns:[], process:[] }
  internalsLens: 'context', // 'context' | 'process' | 'review'
  evaluatorModel: null,     // model id used by the meta-evaluator
  registry: [], providers: [], showAllModels: false,
  skillsAll: [], skillsEnabledIds: new Set(), skillEditing: null, skillsSource: null,
  agents: [], agentEditing: null,
  mcpServers: [], mcpEditing: null, mcpTransport: 'stdio', mcpTools: null,
  editing: null,            // provider id being edited, or null for new
  editorType: null,         // provider type selected in the editor dropdown
  modelOptions: [],         // model ids offered in the Default-model combobox
  testedModels: null        // models from the last successful test in the editor
};

function whoLabel(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 'OPUS';
  if (m.includes('sonnet')) return 'SONNET';
  if (m.includes('claude')) return 'CLAUDE';
  if (m.includes('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'GPT';
  if (m.includes('qwen')) return 'QWEN';
  if (m.includes('kimi') || m.includes('moonshot')) return 'KIMI';
  if (m.includes('gemini')) return 'GEMINI';
  if (m.includes('llama')) return 'LLAMA';
  return (m.split(/[-\s]/)[0] || 'ai').toUpperCase();
}
function modelTag(model) { return String(model || 'no model').toUpperCase(); }

const PAGE_NOTES = {
  chat: () => `${state.documents.length} DOCS IN SCOPE`,
  overview: () => 'UPDATED AUTOMATICALLY',
  internals: () => 'LAST TURN · READ-ONLY',
  agents: () => `${state.agents.length} AGENT${state.agents.length === 1 ? '' : 'S'}`,
  documents: () => `${state.documents.length} DOCUMENTS`,
  models: () => `${state.providers.length} CONNECTIONS`
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ── Minimal, safe Markdown → HTML (zero-dep) ───────────────────────
function renderInline(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => /^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}" class="mdlink">${txt}</a>` : txt);
  return t;
}
function splitRow(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()); }

// Returns HTML; pushes raw html/svg code blocks into `previews` and leaves a placeholder.
function mdToHtml(md, previews) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const code = buf.join('\n');
      if (/^(html|svg|xml)$/i.test(lang)) { const idx = previews.push(code) - 1; html += `<div class="htmlblock" data-idx="${idx}"></div>`; }
      else html += `<pre class="codeblock"><code>${escapeHtml(code)}</code></pre>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const lvl = h[1].length; html += `<h${lvl} class="md-h">${renderInline(h[2])}</h${lvl}>`; i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { html += '<hr class="md-hr">'; i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && /-/.test(lines[i + 1]) && /^\s*\|?[-:\s|]+\|?\s*$/.test(lines[i + 1])) {
      const header = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      html += '<table class="md-table"><thead><tr>' + header.map((c) => `<th>${renderInline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
      continue;
    }
    if (/^\s*>\s?/.test(line)) { const buf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } html += `<blockquote class="md-quote">${renderInline(buf.join(' '))}</blockquote>`; continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line); const tag = ordered ? 'ol' : 'ul'; const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')); i++; }
      html += `<${tag} class="md-list">` + items.map((it) => `<li>${renderInline(it)}</li>`).join('') + `</${tag}>`;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+\.)\s|\s*(-{3,}|\*{3,}))/.test(lines[i]) && !lines[i].includes('|')) { buf.push(lines[i]); i++; }
    html += `<p class="md-p">${renderInline(buf.join(' '))}</p>`;
  }
  return html;
}

// Streaming display: show prose (and plain code) live, but BUFFER html/svg
// blocks behind a placeholder so raw markup doesn't stream at the user. The full
// markdown + sandboxed render happens once, at completion (renderAssistantBody).
function renderStreaming(el, text) {
  const parts = String(text).split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) { html += escapeHtml(parts[i]).replace(/\n/g, '<br>'); continue; }
    const seg = parts[i];
    const nl = seg.indexOf('\n');
    const lang = (nl >= 0 ? seg.slice(0, nl) : seg).trim().toLowerCase();
    const open = i === parts.length - 1; // no closing fence yet
    if (/^(html|svg|xml)$/.test(lang)) {
      html += `<div class="streamph">▣ ${open ? 'generating' : 'prepared'} ${escapeHtml(lang.toUpperCase())} report${open ? '…' : ''}</div>`;
    } else {
      const code = nl >= 0 ? seg.slice(nl + 1) : seg;
      html += `<pre class="codeblock"><code>${escapeHtml(code)}</code></pre>`;
    }
  }
  html += '<span class="streamcaret">▍</span>';
  el.innerHTML = html;
}
let _streamRenderAt = 0, _streamPending = null;
function streamRender(el, text) {
  clearTimeout(_streamPending);
  const now = Date.now();
  if (now - _streamRenderAt >= 40) { _streamRenderAt = now; renderStreaming(el, text); }
  else _streamPending = setTimeout(() => { _streamRenderAt = Date.now(); renderStreaming(el, text); }, 45);
}

// Render assistant markdown into `el`, mounting html/svg previews as sandboxed
// iframes (own origin via blob: → no script exec, no access to the app).
function renderAssistantBody(el, text) {
  const previews = [];
  el.innerHTML = mdToHtml(text || '', previews);
  el.querySelectorAll('.htmlblock').forEach((div) => {
    const raw = previews[+div.dataset.idx] || '';
    const bar = document.createElement('div'); bar.className = 'htmlbar';
    const label = document.createElement('span'); label.className = 'htmlbar__label'; label.textContent = 'RENDERED';
    const toggle = document.createElement('button'); toggle.className = 'htmlbar__btn'; toggle.type = 'button'; toggle.textContent = '</> source';
    bar.appendChild(label); bar.appendChild(toggle);
    const openBtn = document.createElement('button'); openBtn.className = 'htmlbar__btn'; openBtn.type = 'button'; openBtn.textContent = '▸ open in panel';
    openBtn.title = 'Open in the artifact panel — runs scripts in an embedded browser with DevTools';
    openBtn.onclick = () => openArtifact(raw, 'REPORT');
    bar.insertBefore(openBtn, toggle);
    const frame = document.createElement('iframe'); frame.className = 'htmlpreview'; frame.setAttribute('sandbox', '');
    frame.src = URL.createObjectURL(new Blob([raw], { type: 'text/html' }));
    const pre = document.createElement('pre'); pre.className = 'codeblock'; pre.hidden = true; pre.textContent = raw;
    let showingSource = false;
    toggle.onclick = () => { showingSource = !showingSource; frame.hidden = showingSource; pre.hidden = !showingSource; toggle.textContent = showingSource ? '▷ preview' : '</> source'; };
    div.appendChild(bar); div.appendChild(frame); div.appendChild(pre);
  });
  el.querySelectorAll('a.mdlink').forEach((a) => { a.onclick = (e) => { e.preventDefault(); const h = a.getAttribute('href'); if (h) window.api.openExternal(h); }; });
}

// ── Theme ─────────────────────────────────────────────────────────
function applyTheme() {
  if (state.theme === 'light') el.html.setAttribute('data-b-theme', 'light');
  else el.html.removeAttribute('data-b-theme');
  el.themeBtn.textContent = state.theme === 'dark' ? 'LIGHT' : 'DARK';
}
function toggleTheme() { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); }

// ── Model switcher (dynamic, from providers) ──────────────────────
function providerModels(p) {
  if (p.models && p.models.length) return p.models;
  if (p.default_model) return [p.default_model];
  return [];
}

// "Major" = flagship chat models; hide dated/preview/experimental/specialty variants.
function isMajorModel(m) {
  const s = String(m).toLowerCase();
  return !/(exp|preview|beta|nightly|thinking|tuning|latest|vision|embed|-\d{4}$|\d{4}-\d{2}-\d{2})/.test(s);
}

function buildModelMenu() {
  el.modelMenu.innerHTML = '';
  const enabled = state.providers.filter((p) => p.enabled);
  let any = false;
  let hiddenCount = 0;

  for (const p of enabled) {
    const all = providerModels(p);
    if (!all.length) continue;
    let list;
    if (state.showAllModels) {
      list = all;
    } else {
      const major = all.filter(isMajorModel);
      list = (major.length ? major : all).slice(0, 8);
      // Always keep the currently-selected model visible.
      if (state.selected && state.selected.providerId === p.id && all.includes(state.selected.model) && !list.includes(state.selected.model)) list = [state.selected.model, ...list];
      hiddenCount += all.length - list.length;
    }
    if (!list.length) continue;
    any = true;
    const g = document.createElement('div');
    g.className = 'menu__group';
    g.textContent = (p.label || p.type).toUpperCase();
    el.modelMenu.appendChild(g);
    for (const m of list) {
      const b = document.createElement('button');
      b.className = 'menu__item'; b.type = 'button';
      const on = state.selected && state.selected.providerId === p.id && state.selected.model === m;
      b.innerHTML = `<span class="tick">${on ? '›' : ''}</span>${escapeHtml(m)}`;
      b.onclick = () => selectModel(p.id, m);
      el.modelMenu.appendChild(b);
    }
  }

  if (!any) {
    const empty = document.createElement('div');
    empty.className = 'menu__group';
    empty.textContent = 'NO CONNECTIONS';
    el.modelMenu.appendChild(empty);
  }

  const sep = document.createElement('div'); sep.className = 'menu__sep'; el.modelMenu.appendChild(sep);
  if (any) {
    const toggle = document.createElement('button');
    toggle.className = 'menu__item'; toggle.type = 'button';
    toggle.innerHTML = `<span class="tick">${state.showAllModels ? '☑' : '☐'}</span>Show all models` + (!state.showAllModels && hiddenCount > 0 ? `<span class="menu__meta">+${hiddenCount}</span>` : '');
    toggle.onclick = (e) => { e.stopPropagation(); state.showAllModels = !state.showAllModels; buildModelMenu(); };
    el.modelMenu.appendChild(toggle);
  }
  const manage = document.createElement('button');
  manage.className = 'menu__item'; manage.type = 'button';
  manage.innerHTML = '<span class="tick"></span>Manage connections…';
  manage.onclick = () => { toggleModelMenu(false); showModels(); };
  el.modelMenu.appendChild(manage);
}

function toggleModelMenu(force) { const show = force ?? el.modelMenu.hidden; if (show) buildModelMenu(); el.modelMenu.hidden = !show; }

function selectModel(providerId, model) {
  state.selected = { providerId, model };
  el.modelLabel.textContent = model;
  updateComposerMeta();
  toggleModelMenu(false);
  // Persist so the choice survives a restart: globally (for new chats / boot)
  // and on the open chat (so reopening it keeps this model).
  window.api.settings.set('last_model', model);
  if (state.currentChatId) {
    window.api.chats.setModel(state.currentChatId, model);
    const c = state.chats.find((x) => x.id === state.currentChatId);
    if (c) c.model = model;
  }
  updateModelSwitch();
  if (state.page === 'overview') renderOverview();
}

// Show a quick-switch chip when the open project prefers a different model.
function updateModelSwitch() {
  if (!el.modelSwitch) return;
  const proj = state.projects.find((p) => p.id === state.currentProjectId);
  const pref = proj && proj.preferred_model;
  const cur = state.selected && state.selected.model;
  if (pref && cur && pref !== cur && resolveProvider(pref).providerId) {
    el.modelSwitch.hidden = false;
    el.modelSwitch.textContent = '→ ' + pref;
    el.modelSwitch.title = 'Switch to preferred model: ' + pref;
  } else {
    el.modelSwitch.hidden = true;
  }
}

function resolveProvider(model) {
  for (const p of state.providers) {
    if (!p.enabled) continue;
    if ((p.models && p.models.includes(model)) || p.default_model === model) return { providerId: p.id, model };
  }
  return { providerId: null, model };
}

function defaultSelection() {
  const p = state.providers.find((x) => x.enabled && providerModels(x).length);
  if (!p) return null;
  return { providerId: p.id, model: providerModels(p)[0] };
}

// ── Navigation ────────────────────────────────────────────────────
function showPage(page) {
  state.page = page;
  el.pages.querySelectorAll('.page').forEach((s) => { s.hidden = s.dataset.page !== page; });
  el.tabbar.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.page === page));
  el.toolbarNote.textContent = PAGE_NOTES[page] ? PAGE_NOTES[page]() : '';
  el.tbSlug.textContent = '/ ' + page;
  if (page === 'overview') renderOverview();
  if (page === 'internals') renderInternals();
  if (page === 'documents') renderDocumentsPage();
}
function showFirstRun() {
  el.tabbar.hidden = true;
  el.pages.querySelectorAll('.page').forEach((s) => { s.hidden = s.dataset.page !== 'firstrun'; });
  el.tbSlug.textContent = '';
}
function showRail(name) {
  if (name === 'vars') renderVars();
  el.railTabs.querySelectorAll('.rail__tab').forEach((b) => b.classList.toggle('is-active', b.dataset.rail === name));
  document.querySelectorAll('.rail__panel').forEach((p) => { p.hidden = p.dataset.rail !== name; });
}

// ── Rendering: sidebar/chat ───────────────────────────────────────
function renderProjects() {
  el.projectList.innerHTML = '';
  for (const p of state.projects) {
    const li = document.createElement('li');
    li.className = 'list__item' + (p.id === state.currentProjectId ? ' is-selected' : '');
    li.textContent = p.name;
    li.onclick = () => selectProject(p.id);
    el.projectList.appendChild(li);
  }
}
function renderOverview() {
  const p = state.projects.find((x) => x.id === state.currentProjectId);
  if (!p) return;
  el.ovName.textContent = (p.name || 'Project').toUpperCase();
  const dir = p.working_dir;
  el.ovWdPath.textContent = dir || 'Not set';
  el.ovWdPath.title = dir || '';
  el.ovWdPath.classList.toggle('is-empty', !dir);
  el.ovWdChange.textContent = dir ? 'CHANGE' : 'SET DIRECTORY';
  el.ovWdReveal.hidden = !dir;
  updateOutputDir(p);
  el.ovPrefLabel.textContent = p.preferred_model || 'None';
  el.ovModel.textContent = state.selected?.model || '—';
  const activeProvider = state.selected && state.providers.find((x) => x.id === state.selected.providerId);
  el.ovFastLabel.textContent = activeProvider ? (activeProvider.fast_model || 'same as chat model') : '—';
  el.ovFastBtn.disabled = !activeProvider;
  el.ovChats.textContent = state.chats.length;
  el.ovDocs.textContent = state.documents.length;
  el.ovSkills.textContent = state.skills.length;
  el.ovMcp.textContent = state.mcpServers.filter((s) => s.enabled).length;
  // Only reset the cheat-sheet textarea on an actual project switch — this fn
  // also re-runs on unrelated state changes (e.g. model switch) while the
  // overview page is open, and that must not clobber an in-progress edit.
  if (el.ovCheat.dataset.projectId !== String(p.id)) {
    el.ovCheat.value = p.cheat_sheet || '';
    el.ovCheat.dataset.projectId = String(p.id);
    el.ovCheatMsg.textContent = '';
  }
  renderOverviewScope();
  loadBuildEnv(p.id);
  loadDocTargets(p.id);
  updateModelSwitch();
}
// DOCUMENT TARGETS (Overview ↔ chat, either fills them): the format target
// file, the branding text, and the raw-data (Excel) checkbox.
async function loadDocTargets(projectId) {
  const brand = document.getElementById('ov-brand');
  if (!brand) return;
  const fresh = brand.dataset.projectId !== String(projectId);
  try {
    const r = await window.api.documents.listFormats(projectId);
    const pathEl = document.getElementById('ov-fmt-path');
    const sel = document.getElementById('ov-fmt-select');
    const reveal = document.getElementById('ov-fmt-reveal');
    pathEl.textContent = r.active || 'None — documents use plain styling';
    pathEl.title = r.active ? `${r.dir}/${r.active}` : '';
    pathEl.classList.toggle('is-empty', !r.active);
    reveal.hidden = !r.active;
    reveal.dataset.dir = r.dir || '';
    sel.hidden = r.formats.length < 2;
    if (r.formats.length >= 2) {
      sel.innerHTML = r.formats.map((f) => `<option value="${escapeHtml(f)}"${f === r.active ? ' selected' : ''}>${escapeHtml(f)}</option>`).join('');
    }
  } catch {}
  if (fresh) {
    try { brand.value = (await window.api.settings.get('output_branding', projectId)) || ''; } catch { brand.value = ''; }
    brand.dataset.projectId = String(projectId);
    document.getElementById('ov-brand-msg').textContent = '';
  }
  try { document.getElementById('ov-rawdata').checked = (await window.api.settings.get('output_rawdata', projectId)) === '1'; } catch {}
}
document.getElementById('ov-fmt-add').onclick = async () => {
  const pid = state.currentProjectId; if (!pid) return;
  try { const r = await window.api.documents.installFormat(pid); if (!r || !r.canceled) loadDocTargets(pid); } catch {}
};
document.getElementById('ov-fmt-select').onchange = async (e) => {
  const pid = state.currentProjectId; if (!pid) return;
  try { await window.api.settings.set('output_format', 'formats/' + e.target.value, pid); } catch {}
  loadDocTargets(pid);
};
document.getElementById('ov-fmt-reveal').onclick = (e) => { const d = e.target.dataset.dir; if (d) window.api.projects.revealPath(d); };
document.getElementById('ov-brand-save').onclick = async () => {
  const pid = state.currentProjectId; if (!pid) return;
  const msg = document.getElementById('ov-brand-msg');
  try {
    await window.api.settings.set('output_branding', document.getElementById('ov-brand').value.trim(), pid);
    await window.api.settings.set('output_rawdata', document.getElementById('ov-rawdata').checked ? '1' : '0', pid);
    msg.textContent = 'saved'; msg.className = 'test-result';
  } catch { msg.textContent = 'save failed'; msg.className = 'test-result test-result--error'; }
  setTimeout(() => { msg.textContent = ''; }, 2500);
};
document.getElementById('ov-rawdata').onchange = async (e) => {
  const pid = state.currentProjectId; if (!pid) return;
  try { await window.api.settings.set('output_rawdata', e.target.checked ? '1' : '0', pid); } catch {}
};
// The output dir may be an explicit setting or a resolved default — ask main.
async function updateOutputDir(p) {
  if (!el.ovOutPath || !p) return;
  try {
    const eff = await window.api.projects.effectiveOutputDir(p.id);
    const dir = eff && eff.outputDir;
    el.ovOutPath.textContent = dir || '—';
    el.ovOutPath.title = dir || '';
    el.ovOutPath.classList.toggle('is-empty', !(eff && eff.explicit));
    el.ovOutChange.textContent = (eff && eff.explicit) ? 'CHANGE' : 'SET (default shown)';
  } catch { el.ovOutPath.textContent = '—'; }
}
// Build environment (Overview): KEY=VALUE lines merged into every command and
// dev server this project runs.
async function loadBuildEnv(projectId) {
  const ta = document.getElementById('ov-env');
  if (!ta || ta.dataset.projectId === String(projectId)) return;
  try { ta.value = (await window.api.settings.get('build_env', projectId)) || ''; } catch { ta.value = ''; }
  ta.dataset.projectId = String(projectId);
  document.getElementById('ov-env-msg').textContent = '';
}
async function saveBuildEnv() {
  const pid = state.currentProjectId; if (!pid) return;
  const ta = document.getElementById('ov-env');
  const msg = document.getElementById('ov-env-msg');
  const bad = ta.value.split('\n').filter((l) => l.trim() && !/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.test(l));
  if (bad.length) { msg.textContent = `ignoring ${bad.length} malformed line${bad.length === 1 ? '' : 's'}`; msg.className = 'test-result test-result--error'; }
  else { msg.textContent = 'saved'; msg.className = 'test-result'; }
  try { await window.api.settings.set('build_env', ta.value, pid); } catch {}
  setTimeout(() => { msg.textContent = ''; }, 2500);
}

async function saveCheatSheet() {
  const p = state.projects.find((x) => x.id === state.currentProjectId);
  if (!p) return;
  const text = el.ovCheat.value.trim() || null;
  const updated = await window.api.projects.setCheatSheet(p.id, text);
  const i = state.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) state.projects[i] = updated;
  el.ovCheatMsg.textContent = 'saved';
  el.ovCheatMsg.className = 'test-result test-result--ok';
  setTimeout(() => { if (el.ovCheatMsg.textContent === 'saved') el.ovCheatMsg.textContent = ''; }, 1500);
}

function buildPrefMenu() {
  el.ovPrefMenu.innerHTML = '';
  const proj = state.projects.find((p) => p.id === state.currentProjectId);
  const cur = proj && proj.preferred_model;

  const none = document.createElement('button');
  none.className = 'menu__item'; none.type = 'button';
  none.innerHTML = `<span class="tick">${!cur ? '›' : ''}</span>None`;
  none.onclick = () => setPreferred(null);
  el.ovPrefMenu.appendChild(none);

  for (const p of state.providers.filter((x) => x.enabled)) {
    const all = providerModels(p);
    if (!all.length) continue;
    const major = all.filter(isMajorModel);
    let list = (major.length ? major : all).slice(0, 8);
    if (cur && all.includes(cur) && !list.includes(cur)) list = [cur, ...list];
    const g = document.createElement('div');
    g.className = 'menu__group'; g.textContent = (p.label || p.type).toUpperCase();
    el.ovPrefMenu.appendChild(g);
    for (const m of list) {
      const b = document.createElement('button');
      b.className = 'menu__item'; b.type = 'button';
      b.innerHTML = `<span class="tick">${cur === m ? '›' : ''}</span>${escapeHtml(m)}`;
      b.onclick = () => setPreferred(m);
      el.ovPrefMenu.appendChild(b);
    }
  }
}

async function setPreferred(model) {
  const id = state.currentProjectId;
  if (!id) return;
  const updated = await window.api.projects.setPreferredModel(id, model);
  const i = state.projects.findIndex((p) => p.id === id);
  if (i >= 0) state.projects[i] = updated;
  el.ovPrefMenu.hidden = true;
  renderOverview();
}

// Planning model — a property of the CONNECTION behind the current chat model
// (providers.fast_model), not the project. Quick-access picker so this doesn't
// stay buried in "Manage connections → Edit"; suggestions are filtered to
// fast/small-tier ids the same way the connection editor's combo is.
function buildFastMenu() {
  el.ovFastMenu.innerHTML = '';
  const p = state.selected && state.providers.find((x) => x.id === state.selected.providerId);
  if (!p) return;
  const cur = p.fast_model || null;

  const none = document.createElement('button');
  none.className = 'menu__item'; none.type = 'button';
  none.innerHTML = `<span class="tick">${!cur ? '›' : ''}</span>Same as chat model`;
  none.onclick = () => setFastModel(p.id, null);
  el.ovFastMenu.appendChild(none);

  const all = providerModels(p);
  const fast = all.filter(looksLikeFastModel);
  const list = fast.length ? fast : all;
  if (list.length) {
    const g = document.createElement('div');
    g.className = 'menu__group'; g.textContent = (p.label || p.type).toUpperCase() + (fast.length ? '' : ' · no obviously-fast id found, showing all');
    el.ovFastMenu.appendChild(g);
    for (const m of list) {
      const b = document.createElement('button');
      b.className = 'menu__item'; b.type = 'button';
      b.innerHTML = `<span class="tick">${cur === m ? '›' : ''}</span>${escapeHtml(m)}`;
      b.onclick = () => setFastModel(p.id, m);
      el.ovFastMenu.appendChild(b);
    }
  }
}

async function setFastModel(providerId, model) {
  const updated = await window.api.providers.update(providerId, { fastModel: model });
  const i = state.providers.findIndex((p) => p.id === providerId);
  if (i >= 0) state.providers[i] = updated;
  el.ovFastMenu.hidden = true;
  renderOverview();
}

function renderChats() {
  el.chatList.innerHTML = '';
  for (const c of state.chats) {
    const li = document.createElement('li');
    li.className = 'list__item list__item--chat' + (c.id === state.currentChatId ? ' is-selected' : '');
    li.innerHTML = `<div class="chatrow"><div class="chatrow__text"><div class="title">${escapeHtml(c.title || 'Untitled chat')}</div><div class="sub">${escapeHtml((c.model || 'no model').toLowerCase())}</div></div><div class="chatrow__actions"><button class="rowbtn" title="Rename">✎</button><button class="rowbtn" title="Delete">✕</button></div></div>`;
    const [renameBtn, delBtn] = li.querySelectorAll('.rowbtn');
    li.querySelector('.chatrow__text').onclick = () => selectChat(c.id);
    renameBtn.onclick = (e) => { e.stopPropagation(); startRenameChat(li, c); };
    delBtn.onclick = (e) => { e.stopPropagation(); archiveChat(c); };
    el.chatList.appendChild(li);
  }
}

function startRenameChat(li, c) {
  const titleEl = li.querySelector('.title');
  const input = document.createElement('input');
  input.className = 'chatrename';
  input.value = c.title || '';
  titleEl.replaceWith(input);
  input.focus(); input.select();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { input.onblur = null; renderChats(); }
  };
  input.onblur = async () => {
    const v = input.value.trim();
    if (v && v !== c.title) await window.api.chats.rename(c.id, v);
    state.chats = await window.api.chats.list(state.currentProjectId);
    renderChats();
  };
}

async function archiveChat(c) {
  await window.api.chats.archive(c.id);
  state.chats = await window.api.chats.list(state.currentProjectId);
  renderChats();
  if (state.currentChatId === c.id) {
    if (state.chats.length) selectChat(state.chats[0].id);
    else { state.currentChatId = null; el.messages.innerHTML = ''; turn('NO CHATS YET · HIT + NEXT TO CHATS', 'meta'); el.send.disabled = true; }
  }
}
// A generated document just landed on disk — refresh the project's doc list.
async function onDocumentSaved(ev) {
  if (!state.currentProjectId) return;
  try {
    state.documents = await window.api.documents.list(state.currentProjectId);
    renderDocs();
    if (state.page === 'overview') renderOverview();
  } catch (e) { /* non-fatal */ }
}

function renderDocs() {
  el.railDocList.innerHTML = '';
  for (const d of state.documents) {
    const li = document.createElement('li');
    li.className = 'raillist__item';
    const mono = /\.(py|js|ts|json|jsonl|csv|sh|sql|diff|patch)$/i.test(d.title) ? ' title--mono' : '';
    li.innerHTML = `<div class="title${mono}">${escapeHtml(d.title)}</div><div class="sub">${escapeHtml(d.mime_type || 'text')} · ${escapeHtml(d.source || 'doc')}</div>`;
    el.railDocList.appendChild(li);
  }
  updateComposerMeta();
  if (state.page === 'chat') el.toolbarNote.textContent = PAGE_NOTES.chat();
}
// ── Project scope ──────────────────────────────────────────────────────────
// One home: the OVERVIEW page scopes what this project can use (skills + MCP
// connectors, opt-out — OFF never reaches this project's chats). The MCP and
// SKILLS pages create/import/manage the library; the SCOPE rail is a
// read-only summary.
function scopeRow({ label, sub, on, onToggle }) {
  const li = document.createElement('li');
  li.className = 'raillist__item';
  li.innerHTML = `<div class="title"><span class="tick">${on ? '☑' : '☐'}</span>${escapeHtml(label)}</div>`
    + (sub ? `<div class="sub">${escapeHtml(sub)}</div>` : '');
  li.onclick = onToggle;
  li.title = on ? 'In scope for this project — click to exclude' : 'Out of scope — click to enable';
  return li;
}

async function refreshScope() {
  await loadSkills();                       // reloads skillsAll + enabledIds
  if (state.currentProjectId) {
    try { state.projectMcpIds = new Set((await window.api.mcp.enabledForProject(state.currentProjectId)).map((s) => s.id)); } catch {}
  }
  renderScope();
  renderOverviewScope();
  updateComposerMeta();
}

// Interactive scoping — lives on the project OVERVIEW page.
function renderOverviewScope() {
  const pid = state.currentProjectId;
  const g = (id) => document.getElementById(id);
  if (!g('ov-skills-list')) return;

  const allSkills = state.skillsAll || [];
  const enabledIds = state.skillsEnabledIds || new Set();
  g('ov-skills-head').textContent = `SKILLS · ${enabledIds.size}/${allSkills.length} IN SCOPE`;
  const skl = g('ov-skills-list'); skl.innerHTML = '';
  g('ov-skills-empty').hidden = allSkills.length > 0;
  for (const s of allSkills) {
    const on = enabledIds.has(s.id);
    skl.appendChild(scopeRow({
      label: s.name, sub: null, on,
      onToggle: async () => { if (!pid) return; await window.api.skills.setForProject({ projectId: pid, skillId: s.id, enabled: !on }); refreshScope(); }
    }));
  }

  const servers = state.mcpServers.filter((s) => s.enabled);
  const mcpIds = state.projectMcpIds || new Set(servers.map((s) => s.id));
  g('ov-mcp-head').textContent = `MCP CONNECTORS · ${servers.filter((s) => mcpIds.has(s.id)).length}/${servers.length} IN SCOPE`;
  const ml = g('ov-mcp-list'); ml.innerHTML = '';
  g('ov-mcp-empty').hidden = servers.length > 0;
  for (const s of servers) {
    const on = mcpIds.has(s.id);
    ml.appendChild(scopeRow({
      label: s.name, sub: `${s.transport} · ${(s.tools || []).length} tools · ${s.status || 'untested'}`, on,
      onToggle: async () => { if (!pid) return; await window.api.mcp.setForProject({ projectId: pid, serverId: s.id, enabled: !on }); refreshScope(); }
    }));
  }
}

// ── DOCUMENTS page: the project library (canonical docs + deliverables) ────
const DOC_CANON = [
  { type: 'spec', sub: 'objectives · requirements · decision records' },
  { type: 'design', sub: 'architecture · module map · interfaces' },
  { type: 'pseudocode', sub: 'component outlines' },
  { type: 'knowledge', sub: 'contracts · gotchas · glossary' }
];
async function renderDocumentsPage() {
  if (!state.currentProjectId) return;
  try { state.documents = await window.api.documents.list(state.currentProjectId); } catch {}
  const g = (id) => document.getElementById(id);
  const canonUl = g('docs-canonical'), otherUl = g('docs-other');
  if (!canonUl) return;
  canonUl.innerHTML = ''; otherUl.innerHTML = '';
  const canonTypes = new Set(DOC_CANON.map((c) => c.type));

  const row = (d, sub) => {
    const li = document.createElement('li'); li.className = 'conn';
    const when = (d.updated_at || d.created_at || '').slice(0, 16);
    li.innerHTML = `
      <span class="conn__status${canonTypes.has(d.doc_type) ? ' conn__status--ok' : ''}"></span>
      <div class="conn__info"><div class="conn__label">${escapeHtml(d.title)}</div><div class="conn__type">${escapeHtml(d.doc_type || d.source || 'doc')}</div></div>
      <div class="conn__mid"><div class="conn__url">${escapeHtml(sub || d.path || '')}</div><div class="conn__meta">v${d.version || 1}${when ? ' · ' + escapeHtml(when) : ''}</div></div>
      <div class="conn__actions"></div>`;
    const actions = li.querySelector('.conn__actions');
    const view = document.createElement('button'); view.className = 'conn__btn'; view.textContent = 'VIEW';
    view.onclick = async () => {
      const r = await window.api.documents.read(d.id);
      if (r && r.error) { g('doc-reader-title').textContent = d.title; g('doc-reader-body').textContent = r.error; g('doc-reader').hidden = false; return; }
      if (/html/.test(r.mime || '')) { openArtifact(r.content, d.title); return; }
      g('doc-reader-title').textContent = `${d.title} · v${d.version || 1}`;
      g('doc-reader-body').innerHTML = mdToHtml(r.content || '(empty)', []);
      g('doc-reader').hidden = false;
      g('doc-reader').scrollIntoView({ block: 'nearest' });
    };
    actions.appendChild(view);
    if (d.path) {
      const rev = document.createElement('button'); rev.className = 'conn__btn'; rev.textContent = 'FINDER';
      rev.onclick = () => window.api.projects.revealPath(d.path);
      actions.appendChild(rev);
    }
    return li;
  };

  // Canonical docs in their designed order, with their role as the subtitle.
  for (const c of DOC_CANON) {
    const d = state.documents.find((x) => x.doc_type === c.type);
    if (d) canonUl.appendChild(row(d, c.sub));
  }
  // Everything else: deliverables, uploads, user docs.
  const others = state.documents.filter((d) => !canonTypes.has(d.doc_type));
  g('docs-other-empty').hidden = others.length > 0;
  for (const d of others) otherUl.appendChild(row(d));
}
document.getElementById('docs-reveal').onclick = async () => {
  if (!state.currentProjectId) return;
  try { const eff = await window.api.projects.effectiveOutputDir(state.currentProjectId); if (eff && eff.outputDir) window.api.projects.revealPath(eff.outputDir); } catch {}
};
document.getElementById('doc-reader-close').onclick = () => { document.getElementById('doc-reader').hidden = true; };

// ── KNOWN VALUES rail: what this chat has learned, visible and editable ────
async function renderVars() {
  const list = document.getElementById('vars-list');
  const head = document.getElementById('vars-head');
  if (!list || !state.currentChatId) return;
  let vars = [];
  try { const v = await window.api.chats.variables(state.currentChatId); vars = Array.isArray(v) ? v : []; } catch {}
  head.textContent = `KNOWN VALUES · ${vars.length}`;
  list.innerHTML = '';
  for (const v of vars) {
    const li = document.createElement('li');
    li.className = 'raillist__item';
    li.innerHTML = `<div class="title">${escapeHtml(v.key)}</div>`
      + `<div class="sub">${escapeHtml(String(v.value).slice(0, 90))} · ${escapeHtml(v.confidence || 'observed')}</div>`;
    li.title = 'Click to edit — your value outranks anything the model observed. Empty clears it.';
    li.onclick = async () => {
      const next = window.prompt(`${v.key}\n\nEdit the value (empty clears it):`, String(v.value));
      if (next === null) return;
      try { await window.api.chats.setVariable(state.currentChatId, v.key, next.trim()); } catch {}
      renderVars();
    };
    list.appendChild(li);
  }
  document.getElementById('vars-note').hidden = vars.length > 0;
}

// Read-only summary in the chat rail — points at OVERVIEW for changes.
function renderScope() {
  const allSkills = state.skillsAll || [];
  const enabledIds = state.skillsEnabledIds || new Set();
  el.scopeSkillsHead.textContent = `SKILLS · ${enabledIds.size}/${allSkills.length} IN SCOPE`;
  const names = allSkills.filter((s) => enabledIds.has(s.id)).map((s) => s.name);
  el.scopeSkillsNote.textContent = names.length ? names.join(', ') : 'None in scope for this project.';

  const servers = state.mcpServers.filter((s) => s.enabled);
  const mcpIds = state.projectMcpIds || new Set(servers.map((s) => s.id));
  el.scopeMcpHead.textContent = `MCP CONNECTORS · ${servers.filter((s) => mcpIds.has(s.id)).length}/${servers.length} IN SCOPE`;
  el.scopeMcpList.innerHTML = '';
  el.scopeMcpNote.hidden = servers.length > 0;
  for (const s of servers) {
    const on = mcpIds.has(s.id);
    const li = document.createElement('li');
    li.className = 'raillist__item';
    li.innerHTML = `<div class="title">${on ? '☑' : '☐'} ${escapeHtml(s.name)}</div><div class="sub">${escapeHtml(s.transport)} · ${(s.tools || []).length} tools · ${escapeHtml(s.status || 'untested')}</div>`;
    li.onclick = () => showPage('overview');
    el.scopeMcpList.appendChild(li);
  }
}

async function setAllSkills(enabled) {
  const pid = state.currentProjectId; if (!pid) return;
  for (const s of (state.skillsAll || [])) await window.api.skills.setForProject({ projectId: pid, skillId: s.id, enabled });
  refreshScope();
}
async function setAllMcp(enabled) {
  const pid = state.currentProjectId; if (!pid) return;
  for (const s of state.mcpServers) await window.api.mcp.setForProject({ projectId: pid, serverId: s.id, enabled });
  refreshScope();
}
document.getElementById('ov-skills-all').onclick = () => setAllSkills(true);
document.getElementById('ov-skills-none').onclick = () => setAllSkills(false);
document.getElementById('ov-mcp-all').onclick = () => setAllMcp(true);
document.getElementById('ov-mcp-none').onclick = () => setAllMcp(false);
function chatModeOf(chat) {
  return (chat && (chat.mode || (chat.coding_mode ? 'code' : ''))) || 'work';
}
function updateComposerMeta() {
  const model = state.selected?.model;
  const chat = state.chats.find((c) => c.id === state.currentChatId);
  const mode = chatModeOf(chat);
  const modeTag = chat && mode !== 'work' ? ` · ${mode.toUpperCase()}` : '';
  el.composerScope.textContent = `${state.documents.length} DOCS · ${state.skills.length} SKILLS · ${modelTag(model)}${modeTag}`;
}

// ── Mode of operation (titlebar, per chat): WORK · DOCUMENTS · CODE ──
function updateCodeToggle() {
  const chat = state.chats.find((c) => c.id === state.currentChatId);
  const mode = chatModeOf(chat);
  for (const [btn, m] of [[el.modeWork, 'work'], [el.modeDocs, 'documents'], [el.modeCode, 'code']]) {
    btn.disabled = !chat;
    btn.classList.toggle('is-active', !!chat && mode === m);
  }
  updateBypassChip();
}
async function setChatMode(mode) {
  const chat = state.chats.find((c) => c.id === state.currentChatId);
  if (!chat || chatModeOf(chat) === mode) return;
  if (mode === 'code') {
    const proj = state.projects.find((p) => p.id === state.currentProjectId);
    if (!proj || !proj.working_dir) { showSetupNotice(['workingDir']); return; }
  }
  await window.api.chats.setMode(chat.id, mode);
  chat.mode = mode;
  chat.coding_mode = mode === 'code' ? 1 : 0;
  updateCodeToggle();
  updateComposerMeta();
  // Ask, don't just refuse: a working dir without git means every write
  // prompts and bypass is off — offer the one-click fix at mode entry.
  if (mode === 'code') {
    try {
      const st = await window.api.projects.gitStatus(state.currentProjectId);
      if (st && st.workingDir && !st.hasGit) showGitOffer();
    } catch {}
  }
}

// "Do you want to initialize git?" — shown when a chat enters CODE mode over
// a working directory that isn't a repo yet.
function showGitOffer() {
  const note = document.createElement('div');
  note.className = 'turn turn--setup';
  note.innerHTML = `<div class="turn__body"><div class="setup__title">CODING MODE · NO GIT REPOSITORY</div>`
    + `<div id="git-offer-body">The working directory has no git repo — every file write will need approval and bypass is unavailable. Git provides the rollback that lets writes flow freely.`
    + `<button type="button" class="linkbtn" data-git="init">Initialize git now</button>`
    + `<button type="button" class="linkbtn" data-git="skip">Continue without</button></div></div>`;
  el.messages.appendChild(note);
  el.messages.scrollTop = el.messages.scrollHeight;
  note.querySelector('[data-git="init"]').onclick = async () => {
    const body = note.querySelector('#git-offer-body');
    body.textContent = 'initializing…';
    const r = await window.api.projects.gitInit(state.currentProjectId);
    body.textContent = (r && r.ok)
      ? '✓ git initialized — file writes now flow without prompts; shell still asks (or BYPASS).'
      : `git init failed: ${(r && r.error) || 'unknown'}`;
  };
  note.querySelector('[data-git="skip"]').onclick = () => note.remove();
}
el.modeWork.onclick = () => setChatMode('work');
el.modeDocs.onclick = () => setChatMode('documents');
el.modeCode.onclick = () => setChatMode('code');
// A standing bypass is invisible power — surface it whenever coding mode is
// on, and let one click revoke it (prompts resume immediately; main enforces).
async function updateBypassChip() {
  const chat = state.chats.find((c) => c.id === state.currentChatId);
  let on = false;
  if (chat && chatModeOf(chat) === 'code' && state.currentProjectId) {
    try { on = (await window.api.settings.get('coding_bypass', state.currentProjectId)) === '1'; } catch {}
  }
  el.bypassChip.hidden = !on;
}
el.bypassChip.onclick = async () => {
  try { await window.api.settings.set('coding_bypass', '0', state.currentProjectId); } catch {}
  updateBypassChip();
};
// ── Internals: glass-box context inspector ─────────────────────────
const CONTRIB = {
  system:  { label: 'system',  color: '#9aa0a6' },
  skills:  { label: 'skills',  color: '#2e9e5b' },
  summary: { label: 'summary', color: '#c9821f' },
  history: { label: 'history', color: '#2f73b7' },
  current: { label: 'current', color: '#b3242e' },
  tools:   { label: 'tools',   color: '#7a5cc0' }
};
function fmtTok(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }
function fmtDur(ms) { if (ms == null) return ''; return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + 's' : Math.round(ms) + 'ms'; }

function captureInternals(ev) {
  if (!state.currentChatId) return;
  state.internals[state.currentChatId] = { ledger: ev, toolTurns: [], process: [] };
  updateCtxMeter();
  if (state.page === 'internals') renderInternals();
}
// Sub-agent lifecycle events (delegate → runSubagent) build the thread tree.
function captureProcess(ev) {
  if (ev.kind === 'skill-select') return; // carried on the ledger; nothing to accumulate
  const rec = state.internals[state.currentChatId];
  if (!rec) return;
  rec.process = rec.process || [];
  // Plan-and-execute lifecycle (execute.js/plan-derive.js) — tracked on rec.plan
  // so the PROCESS lens can show the derived plan, per-step status, re-plans and
  // variable captures. Handled BEFORE the sub-agent branch below so these kinds
  // never get misread as sub-agent updates.
  const PLAN_KINDS = { planning: 1, 'planning-done': 1, plan: 1, 'execute-start': 1, 'step-start': 1, 'step-done': 1, 'step-stuck': 1, replan: 1, escalate: 1, 'execute-done': 1, 'var-set': 1, 'var-capture': 1, 'mid-turn-compact': 1, 'group-start': 1, 'group-merge': 1, 'group-merged': 1 };
  if (ev.kind === 'align') { rec.aligned = ev.decisions || true; if (state.page === 'internals' && state.internalsLens === 'process') renderInternals(); return; }
  if (PLAN_KINDS[ev.kind]) {
    if (ev.kind === 'plan') {
      rec.plan = { goal: ev.goal || '', merge: ev.merge || '', steps: (ev.steps || []).map((s) => ({ id: s.id, task: s.task, produces: s.produces || '', parallel: !!s.parallel, status: 'pending' })), replans: 0, vars: 0 };
    } else if (rec.plan) {
      const byId = (id) => rec.plan.steps.find((s) => s.id === id);
      if (ev.kind === 'step-start') { let s = byId(ev.step); if (!s && ev.task) { s = { id: ev.step, task: ev.task, parallel: !!ev.parallel, status: 'pending' }; rec.plan.steps.push(s); } if (s) { s.task = ev.task || s.task; s.status = 'running'; } }
      else if (ev.kind === 'step-done') { const s = byId(ev.step); if (s) s.status = 'done'; }
      else if (ev.kind === 'step-stuck') { const s = byId(ev.step); if (s) s.status = 'stuck'; }
      else if (ev.kind === 'replan') { rec.plan.replans = ev.attempt || (rec.plan.replans + 1); rec.plan.steps = rec.plan.steps.filter((s) => s.status === 'done' || s.status === 'running' || s.status === 'stuck'); }
      else if (ev.kind === 'escalate') { rec.plan.escalated = true; }
      else if (ev.kind === 'execute-done') { rec.plan.completed = ev.completed !== false; }
      else if (ev.kind === 'var-set' || ev.kind === 'var-capture') { rec.plan.vars = (rec.plan.vars || 0) + 1; }
      else if (ev.kind === 'mid-turn-compact') { rec.plan.compacted = true; }
    }
    if (state.page === 'internals' && state.internalsLens === 'process') renderInternals();
    return;
  }
  if (ev.kind === 'merge-start') { rec.merge = { status: 'running', count: ev.count }; if (state.page === 'internals' && state.internalsLens === 'process') renderInternals(); return; }
  if (ev.kind === 'merge-done') { rec.merge = { status: 'done', tokens: ev.tokens }; if (state.page === 'internals' && state.internalsLens === 'process') renderInternals(); return; }
  if (ev.kind === 'subagent-start') {
    rec.process.push({ agent: ev.agent, task: ev.task, status: 'running', tools: 0, conclusionTokens: 0, inputTokens: 0 });
  } else {
    const cur = [...rec.process].reverse().find((p) => p.status === 'running') || rec.process[rec.process.length - 1];
    if (!cur) return;
    if (ev.kind === 'subagent-tool-end') cur.tools += 1;
    else if (ev.kind === 'subagent-done') {
      cur.status = 'done';
      cur.conclusionTokens = ev.conclusionTokens || 0;
      cur.inputTokens = ev.inputTokens || 0;
      cur.tools = ev.tools != null ? ev.tools : cur.tools;
      cur.durationMs = ev.durationMs;
    }
  }
  if (state.page === 'internals' && state.internalsLens === 'process') renderInternals();
}
function captureInternalsTools(ev) {
  const rec = state.internals[state.currentChatId];
  if (!rec) return;
  rec.toolTurns = ev.trace || [];        // authoritative reconcile at end of turn
  if (state.page === 'internals') renderInternals();
}
// Live: a tool just returned mid-loop — append it (filtered) and tick occupancy.
function captureInternalsToolEnd(ev) {
  const rec = state.internals[state.currentChatId];
  if (!rec) return;
  rec.toolTurns = rec.toolTurns || [];
  const raw = Math.ceil((ev.resultChars || 0) / 4);
  const tok = Math.ceil((ev.filteredChars != null ? ev.filteredChars : ev.resultChars || 0) / 4); // what enters context
  rec.toolTurns.push({ name: ev.name, resultTokens: tok, rawTokens: raw, saved: Math.max(0, raw - tok), rules: ev.rules || [], truncated: !!ev.truncated, isError: ev.ok === false, durationMs: ev.durationMs });
  if (rec.ledger) {
    rec.ledger.total += tok;
    const tb = rec.ledger.contributors.find((c) => c.key === 'tools');
    if (tb) tb.tokens += tok; else rec.ledger.contributors.push({ key: 'tools', tokens: tok });
  }
  updateCtxMeter();
  if (state.page === 'internals') renderInternals();
}

function captureMetrics(ev) {
  const rec = state.internals[state.currentChatId];
  if (!rec) return;
  rec.metrics = ev;
  if (state.page === 'internals' && state.internalsLens === 'context') renderInternals();
}

// Render the MEASURED card (real provider usage + reductions) in the CONTEXT lens.
function renderMeasured(rec) {
  const m = rec && rec.metrics;
  if (!m) { el.intMeasuredCard.hidden = true; return; }
  el.intMeasuredCard.hidden = false;
  el.intMeasuredSrc.textContent = m.measured ? 'real provider usage' : 'estimate only (provider sent no usage)';
  const items = [];
  const item = (k, v, cls) => items.push(`<div class="measured__item"><span class="measured__k">${k}</span><span class="measured__v${cls ? ' measured__v--' + cls : ''}">${v}</span></div>`);
  const inTok = m.inputTokens || 0, outTok = m.outputTokens || 0, cached = m.cachedTokens || 0;
  const cachePct = inTok ? Math.round((cached / inTok) * 100) : 0;
  const reductions = (m.skillSavedTokens || 0) + (m.filterSavedTokens || 0) + (m.compactionSavedTokens || 0) + (m.delegateAbsorbedTokens || 0);

  item('turn time', m.durationMs != null ? fmtDur(m.durationMs) : '—');
  item('input tokens', m.measured ? fmtTok(inTok) : '—');
  item('output tokens', m.measured ? fmtTok(outTok) : '—');
  item('cache read', m.measured ? `${fmtTok(cached)} <small>${cachePct}%</small>` : '—', cachePct >= 60 ? 'good' : (cachePct === 0 ? 'warn' : ''));
  item('token reduction', `${fmtTok(reductions)}`, reductions ? 'good' : '');
  item('skills used', `${m.skillsLoaded || 0}<small>/${m.skillsAvailable || 0}</small>`);
  item('delegated', `${m.delegated || 0}${m.delegateAbsorbedTokens ? ` <small>kept ${fmtTok(m.delegateAbsorbedTokens)}</small>` : ''}`);

  let html = items.join('');
  const est = m.estInputTokens || 0;
  if (m.measured && est) {
    const diff = inTok ? Math.round(Math.abs(inTok - est) / inTok * 100) : 0;
    html += `<div class="measured__est">estimate ${fmtTok(est)} vs measured ${fmtTok(inTok)} input — ${diff}% off (chars/4 heuristic)</div>`;
  } else if (!m.measured) {
    html += `<div class="measured__est">provider returned no usage this turn — showing estimate ${fmtTok(est)} input; reductions are still real.</div>`;
  }
  el.intMeasured.innerHTML = html;
}

function updateCtxMeter() {
  const rec = state.internals[state.currentChatId];
  if (!rec || !rec.ledger) { el.ctxMeter.hidden = true; return; }
  const { total, window } = rec.ledger;
  const pct = window ? Math.round((total / window) * 100) : 0;
  el.ctxMeter.hidden = false;
  el.ctxMeter.classList.toggle('is-high', pct >= 60 && pct < 85);
  el.ctxMeter.classList.toggle('is-crit', pct >= 85);
  el.ctxMeter.innerHTML = `<span class="ctxbar"><i style="width:${Math.min(100, pct)}%"></i></span>${pct}% ctx`;
}

function renderInternals() {
  const rec = state.internals[state.currentChatId];
  if (!rec || !rec.ledger) { el.intEmpty.hidden = false; el.intBody.hidden = true; el.intModel.textContent = ''; return; }
  const L = rec.ledger;
  el.intEmpty.hidden = true; el.intBody.hidden = false;
  el.intModel.textContent = L.model || '';

  const lens = state.internalsLens;
  el.intContext.hidden = lens !== 'context';
  el.intProcess.hidden = lens !== 'process';
  el.intReview.hidden = lens !== 'review';
  el.intLenstabs.querySelectorAll('.lenstab').forEach((b) => b.classList.toggle('is-active', b.dataset.lens === lens));
  if (lens === 'process') { renderProcess(rec); return; }
  if (lens === 'review') { renderReview(rec); return; }

  renderMeasured(rec);

  const pct = L.window ? Math.round((L.total / L.window) * 100) : 0;
  el.intWindow.textContent = `${fmtTok(L.total)} / ${fmtTok(L.window)} tok · ${pct}%`;

  // Occupancy bar — segments scaled to the window; headroom (or overflow) shown.
  const denom = Math.max(L.total, L.window) || 1;
  el.intOccbar.innerHTML = '';
  for (const c of L.contributors) {
    const seg = document.createElement('div');
    seg.className = 'occseg occseg--' + c.key;
    seg.style.width = (c.tokens / denom * 100) + '%';
    seg.title = `${(CONTRIB[c.key] || {}).label || c.key}: ${fmtTok(c.tokens)} tok`;
    el.intOccbar.appendChild(seg);
  }
  const free = L.window - L.total;
  el.intLegend.innerHTML = '';
  for (const c of L.contributors) {
    const meta = CONTRIB[c.key] || { label: c.key, color: '#888' };
    const item = document.createElement('div');
    item.className = 'occitem';
    item.innerHTML = `<span class="sw" style="background:${meta.color}"></span>${meta.label} <b>${fmtTok(c.tokens)}</b>`;
    el.intLegend.appendChild(item);
  }
  const freeItem = document.createElement('div');
  freeItem.className = 'occitem';
  freeItem.innerHTML = free >= 0
    ? `<span class="sw" style="background:var(--line)"></span>free <b>${fmtTok(free)}</b>`
    : `<span class="sw" style="background:var(--brand)"></span><b style="color:var(--brand)">OVER by ${fmtTok(-free)}</b>`;
  el.intLegend.appendChild(freeItem);

  // Pipeline events timeline.
  el.intTimeline.innerHTML = '';
  const addEvt = (glyph, label, delta, warn, muted) => {
    const li = document.createElement('li');
    li.className = 'intevt' + (muted ? ' intevt--muted' : '');
    li.innerHTML = `<span class="intevt__glyph">${glyph}</span><span class="intevt__label">${escapeHtml(label)}</span>`
      + (delta ? `<span class="intevt__delta${warn ? ' intevt__delta--warn' : ''}">${escapeHtml(delta)}</span>` : '');
    el.intTimeline.appendChild(li);
  };
  addEvt('▸', 'Assembled prompt from skills, history and current turn', `${fmtTok(L.total)} tok`, false, true);
  for (const e of (L.events || [])) {
    if (e.type === 'skill-select') {
      const label = e.error ? `Selected skills · planning failed, 0 of ${e.available} loaded ⚠ ${e.error}` : `Selected skills · ${e.available} available → ${e.selected} loaded`;
      addEvt('◇', label, e.saved ? `−${fmtTok(e.saved)}` : '', !!e.error);
    } else if (e.type === 'tool-scope') {
      const by = e.fellBack ? 'planning failed — fell back to the full catalog' : (e.bySkills && e.bySkills.length) ? `skills (${e.bySkills.join(', ')})` : 'request relevance';
      addEvt('✂', `Tool scope · ${by} narrowed catalog to ${e.scoped}/${e.totalAvailable} tools`, e.fellBack ? '' : `−${e.totalAvailable - e.scoped} tools`, !!e.fellBack);
    }
    else if (e.type === 'compact') addEvt('⚡', `Compacted older history → summary (${fmtTok(e.tokensBefore)} → ${fmtTok(e.tokensAfter)})`, `−${fmtTok(e.saved)}`);
  }
  if ((L.events || []).every((e) => e.type !== 'compact')) addEvt('✓', 'No compaction needed this turn', '', false, true);
  addEvt('⚙', `${L.toolCount || 0} tools offered to the model`, '', false, true);
  for (const t of (rec.toolTurns || [])) {
    const delta = t.saved ? ` · filtered −${fmtTok(t.saved)}` : '';
    const dur = t.durationMs != null ? ` · ${fmtDur(t.durationMs)}` : '';
    addEvt(t.isError ? '✕' : '↩', `Tool result · ${String(t.name).split('__').pop()}${t.truncated ? ' (elided)' : ''}`, `${fmtTok(t.resultTokens)} tok${delta}${dur}`, t.saved > 0);
  }

  // Assembled prompt viewer.
  el.intMsgcount.textContent = `${L.assembled.length} messages`;
  el.intPrompt.innerHTML = '';
  L.assembled.forEach((m, i) => {
    const meta = CONTRIB[m.contributor] || { label: m.contributor, color: '#888' };
    const card = document.createElement('div');
    card.className = 'intmsg';
    const preview = (m.content || '').replace(/\s+/g, ' ').slice(0, 90) || (m.toolCalls || []).map((t) => `[calls ${t}]`).join(' ') || '(empty)';
    const body = escapeHtml(m.content || '')
      + (m.toolCalls && m.toolCalls.length ? `\n\n<span class="intmsg__clip">↳ tool calls: ${escapeHtml(m.toolCalls.join(', '))}</span>` : '')
      + (m.clippedChars ? `\n<span class="intmsg__clip">…(${fmtTok(m.clippedChars)} more chars not shown)</span>` : '');
    card.innerHTML = `<div class="intmsg__head">`
      + `<span class="intmsg__role">${escapeHtml(m.role)}</span>`
      + `<span class="intmsg__tag" style="background:${meta.color}">${meta.label}</span>`
      + `<span class="intmsg__title">${escapeHtml(preview)}</span>`
      + `<span class="intmsg__tok">${fmtTok(m.tokens)} tok</span></div>`
      + `<pre class="intmsg__body" hidden>${body}</pre>`;
    const head = card.querySelector('.intmsg__head');
    const pre = card.querySelector('.intmsg__body');
    head.onclick = () => { pre.hidden = !pre.hidden; };
    el.intPrompt.appendChild(card);
  });
}

// PROCESS lens — the pipeline stages and the delegated sub-agent tree.
function renderProcess(rec) {
  const L = rec.ledger;
  const compacted = (L.events || []).some((e) => e.type === 'compact');
  const nTools = (rec.toolTurns || []).length;
  const subs = rec.process || [];

  const ss = L.skillSelect;
  const ssDetail = !ss ? 'no skills enabled this turn'
    : ss.error ? `⚠ planning failed, 0 of ${ss.available} loaded — ${ss.error}`
    : `${ss.available} available → ${(ss.selected || []).length} loaded${ss.savedTokens ? ` · saved ${fmtTok(ss.savedTokens)}` : ''}`;
  // Tool-scope isn't a top-level ledger field — it rides on L.events (same
  // source the pipeline timeline reads), so pull it out here too.
  const ts = (L.events || []).find((e) => e.type === 'tool-scope');
  const tsDetail = !ts ? 'no tools connected this turn'
    : ts.fellBack ? `⚠ planning failed — fell back to the full catalog (${ts.scoped}/${ts.totalAvailable} tools)`
    : (ts.bySkills && ts.bySkills.length) ? `${ts.totalAvailable} available → ${ts.scoped} scoped (by skill: ${ts.bySkills.join(', ')})`
    : `${ts.totalAvailable} available → ${ts.scoped} selected by request relevance`;
  const filterSaved = (rec.toolTurns || []).reduce((n, t) => n + (t.saved || 0), 0);
  // 'done' = ran this turn. 'active' = running now. 'idle' = a real, built
  // capability that simply wasn't needed this turn (still shown plainly, not
  // muted). 'warn' = the stage ran but planning failed and fell back.
  // 'planned' is reserved for capabilities that don't exist yet — don't use
  // it to mean "not used this turn" or "failed this turn".
  // Plan-and-execute (Pass 2): the derived plan, its per-step status, and the
  // working memory captured along the way.
  const plan = rec.plan;
  const planDetail = !plan ? 'simple turn — flat loop'
    : `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`
      + (plan.replans ? ` · ${plan.replans} re-plan${plan.replans === 1 ? '' : 's'}` : '')
      + (plan.vars ? ` · ${plan.vars} value${plan.vars === 1 ? '' : 's'} remembered` : '')
      + (plan.escalated ? ' · escalated to user' : '');
  const stages = [
    { name: 'Assemble', detail: `${L.assembled.length} messages`, state: 'done' },
    { name: 'Select skills', detail: ssDetail, state: ss && ss.error ? 'warn' : 'done' },
    { name: 'Select tools', detail: tsDetail, state: ts && ts.fellBack ? 'warn' : 'done' },
    { name: 'Plan', detail: planDetail, state: plan ? (plan.escalated ? 'warn' : 'done') : 'idle' },
    ...(plan ? plan.steps.map((s) => ({
      name: `· Step ${s.id}`,
      detail: `${s.parallel ? '⇉ ' : ''}${(s.task || '').slice(0, 110)}`,
      state: s.status === 'done' ? 'done' : s.status === 'running' ? 'active' : s.status === 'stuck' ? 'warn' : 'idle'
    })) : []),
    { name: 'Compact', detail: compacted ? 'summarized older history' : (plan && plan.compacted ? 'mid-turn (protected known values)' : 'not needed this turn'), state: 'done' },
    { name: 'Route', detail: L.model || '', state: 'done' },
    { name: 'Tool loop', detail: `${nTools} tool call${nTools === 1 ? '' : 's'}`, state: 'done' },
    { name: 'Filter / trim', detail: nTools ? `${nTools} tool result${nTools === 1 ? '' : 's'} filtered · saved ${fmtTok(filterSaved)}` : 'no tool output to filter', state: 'done' },
    { name: 'Delegate', detail: subs.length ? `${subs.length} sub-agent${subs.length === 1 ? '' : 's'}${subs.length > 1 ? ' (parallel)' : ''}` : 'not needed this turn', state: subs.length ? 'done' : 'idle' },
    { name: 'Merge', detail: rec.merge ? (rec.merge.status === 'done' ? `merged ${subs.length} results → ${fmtTok(rec.merge.tokens || 0)} tok` : 'merging…') : (subs.length ? 'returned separately (no merge)' : 'not needed this turn'), state: rec.merge ? (rec.merge.status === 'done' ? 'done' : 'active') : (subs.length ? 'done' : 'idle') },
    { name: 'Persist', detail: 'saved to chat', state: 'done' }
  ];
  const STAGE_TAG = { planned: 'planned', idle: 'not used this turn' };
  el.intStages.innerHTML = '';
  for (const s of stages) {
    const li = document.createElement('li');
    li.className = 'stage stage--' + s.state;
    li.innerHTML = `<span class="stage__dot"></span><span class="stage__name">${escapeHtml(s.name)}</span>`
      + `<span class="stage__detail">${escapeHtml(s.detail)}</span>`
      + (STAGE_TAG[s.state] ? `<span class="stage__tag">${STAGE_TAG[s.state]}</span>` : '');
    el.intStages.appendChild(li);
  }

  // Threads: main + one card per delegated sub-agent.
  el.intThreadmeta.textContent = subs.length ? `main + ${subs.length} sub-agent${subs.length === 1 ? '' : 's'}` : 'main only';
  el.intThreads.innerHTML = '';
  const mainPct = L.window ? Math.min(100, Math.round((L.total / L.window) * 100)) : 0;
  const main = document.createElement('div');
  main.className = 'thread thread--main';
  main.innerHTML = `<div class="thread__head"><span class="thread__name">MAIN THREAD</span>`
    + `<span class="thread__status thread__status--done">${L.model || ''}</span>`
    + `<span class="thread__meter"><i style="width:${mainPct}%"></i></span></div>`
    + `<div class="thread__stats"><span><b>${fmtTok(L.total)}</b> / ${fmtTok(L.window)} tok · ${mainPct}%</span><span><b>${nTools}</b> tools</span><span><b>${subs.length}</b> delegated</span></div>`;
  el.intThreads.appendChild(main);

  for (const s of subs) {
    const win = L.window || 1;
    const subPct = Math.min(100, Math.round(((s.inputTokens || s.conclusionTokens || 0) / win) * 100));
    const saved = Math.max(0, (s.inputTokens || 0) - (s.conclusionTokens || 0));
    const card = document.createElement('div');
    card.className = 'thread thread--sub';
    card.innerHTML = `<div class="thread__head"><span class="thread__name">${escapeHtml(s.agent || 'sub-agent')}</span>`
      + `<span class="thread__status thread__status--${s.status === 'done' ? 'done' : 'running'}">${s.status === 'done' ? 'done' : 'running…'}</span>`
      + `<span class="thread__meter"><i style="width:${subPct}%;background:#7a5cc0"></i></span></div>`
      + `<div class="thread__task">${escapeHtml((s.task || '').slice(0, 200) || '(no task)')}</div>`
      + `<div class="thread__stats">`
      + `<span>absorbed <b>${fmtTok(s.inputTokens || 0)}</b> tok</span>`
      + `<span>returned <b>${fmtTok(s.conclusionTokens || 0)}</b> tok</span>`
      + `<span><b>${s.tools || 0}</b> tool${s.tools === 1 ? '' : 's'}</span>`
      + (s.durationMs != null ? `<span><b>${fmtDur(s.durationMs)}</b></span>` : '')
      + (saved ? `<span class="thread__win">kept ${fmtTok(saved)} out of main</span>` : '')
      + `</div>`;
    el.intThreads.appendChild(card);
  }
  if (rec.merge) {
    const m = document.createElement('div');
    m.className = 'thread thread--merge';
    m.innerHTML = `<div class="thread__head"><span class="thread__name">⋈ MERGE</span>`
      + `<span class="thread__status thread__status--${rec.merge.status === 'done' ? 'done' : 'running'}">${rec.merge.status === 'done' ? 'done' : 'merging…'}</span></div>`
      + `<div class="thread__stats"><span>combined <b>${subs.length}</b> results${rec.merge.tokens ? ` → <b>${fmtTok(rec.merge.tokens)}</b> tok` : ''}</span></div>`;
    el.intThreads.appendChild(m);
  }
  if (!subs.length) {
    const note = document.createElement('div');
    note.className = 'threadtree__empty';
    note.innerHTML = 'No delegation this turn. The orchestrator can call <code>delegate(agent, task)</code> for one sub-agent, or <code>assign(tasks, merge)</code> to run several in parallel and merge — each runs in its own context and returns only a distilled conclusion.';
    el.intThreads.appendChild(note);
  }
}

// ── REVIEW lens — a second LLM critiques the turn ──────────────────
function evalLabel() { return state.evaluatorModel || state.selected?.model || 'pick a model…'; }

function renderReview(rec) {
  el.intEvalLabel.textContent = evalLabel();
  const rv = rec.review; // { running?, assessment?, findings?, error? } | undefined
  el.intEvalRun.disabled = !!(rv && rv.running);
  el.intEvalRun.textContent = (rv && rv.running) ? 'EVALUATING…' : 'EVALUATE LAST TURN';
  el.intEvalAssessment.hidden = !(rv && rv.assessment);
  if (rv && rv.assessment) el.intEvalAssessment.textContent = rv.assessment;

  el.intEvalFindings.innerHTML = '';
  if (!rv) { el.intEvalNote.hidden = false; return; }
  el.intEvalNote.hidden = true;
  const note = (cls, text) => { const d = document.createElement('div'); d.className = 'review__running'; d.textContent = text; el.intEvalFindings.appendChild(d); };
  if (rv.running) return note('', `Reviewing with ${evalLabel()}…`);
  if (rv.error) {
    note('', 'Evaluation error: ' + rv.error);
    if (rv.raw) {
      const pre = document.createElement('pre');
      pre.className = 'intmsg__body'; pre.style.marginTop = '8px';
      pre.textContent = rv.raw;
      el.intEvalFindings.appendChild(pre);
    }
    return;
  }
  if (!rv.findings.length) return note('', 'No issues found — the turn looks efficient.');
  for (const f of rv.findings) {
    const sev = String(f.severity || 'low').toLowerCase();
    const target = String(f.target || 'usage').toLowerCase();
    const card = document.createElement('div');
    card.className = 'finding';
    card.innerHTML = `<div class="finding__head">`
      + `<span class="finding__sev finding__sev--${sev}">${escapeHtml(sev)}</span>`
      + `<span class="finding__cat">${escapeHtml(f.category || '')}</span>`
      + `<span class="finding__target finding__target--${target}">${escapeHtml(target)}</span></div>`
      + `<div class="finding__obs">${escapeHtml(f.observation || '')}</div>`
      + (f.suggestion ? `<div class="finding__sug">${escapeHtml(f.suggestion)}</div>` : '');
    el.intEvalFindings.appendChild(card);
  }
}

function buildEvalMenu() {
  el.intEvalMenu.innerHTML = '';
  const cur = state.evaluatorModel || state.selected?.model;
  for (const p of state.providers.filter((x) => x.enabled)) {
    const all = providerModels(p);
    if (!all.length) continue;
    const major = all.filter(isMajorModel);
    let list = (major.length ? major : all).slice(0, 8);
    if (cur && all.includes(cur) && !list.includes(cur)) list = [cur, ...list];
    const g = document.createElement('div');
    g.className = 'menu__group'; g.textContent = (p.label || p.type).toUpperCase();
    el.intEvalMenu.appendChild(g);
    for (const m of list) {
      const b = document.createElement('button');
      b.className = 'menu__item'; b.type = 'button';
      b.innerHTML = `<span class="tick">${cur === m ? '›' : ''}</span>${escapeHtml(m)}`;
      b.onclick = () => setEvaluator(m);
      el.intEvalMenu.appendChild(b);
    }
  }
}
function setEvaluator(model) {
  state.evaluatorModel = model;
  window.api.settings.set('evaluator_model', model);
  el.intEvalMenu.hidden = true;
  el.intEvalLabel.textContent = evalLabel();
}

// A compact digest of the turn — metrics + structure, never the raw bulk.
function buildDigest(rec) {
  const L = rec.ledger;
  const cur = (L.assembled || []).find((m) => m.contributor === 'current');
  const skillEvt = (L.events || []).find((e) => e.type === 'skill-select');
  const toolEvt = (L.events || []).find((e) => e.type === 'tool-scope');
  return {
    chatModel: L.model,
    window: L.window,
    totalTokens: L.total,
    occupancyPct: L.window ? Math.round((L.total / L.window) * 100) : 0,
    contributors: L.contributors,
    compaction: (L.events || []).filter((e) => e.type === 'compact'),
    // Without this, a failed planning call and a deliberate "nothing needed"
    // decision look identical from the outside (both end up N tools offered,
    // 0 called) — the evaluator would otherwise diagnose a missing feature
    // when the actual cause was this turn's planning call failing.
    planning: {
      skills: skillEvt ? { available: skillEvt.available, loaded: skillEvt.selected, error: skillEvt.error || null } : null,
      tools: toolEvt ? { available: toolEvt.totalAvailable, scoped: toolEvt.scoped, fellBackToFullCatalog: !!toolEvt.fellBack, boundedBySkill: toolEvt.bySkills || null } : null
    },
    // Pass 2 + execution (plan-and-execute): the derived plan, per-step status,
    // re-plans, and working-memory captures. mode "flat-loop" = the planner
    // judged the turn simple (or planning failed/timed out and degraded).
    execution: {
      // An alignment turn is a DELIBERATE outcome (open decisions returned to
      // the user, no steps by design) — reporting it as 'flat-loop' with a
      // null plan made every align turn read to the evaluator as a planning
      // failure.
      mode: rec.plan ? 'plan-and-execute' : rec.aligned ? 'alignment' : 'flat-loop',
      // Evaluations can run MID-TURN — without this the evaluator reads
      // "N tools offered, 0 called" on a still-running turn as waste.
      turnComplete: !!rec.metrics,
      plan: rec.plan ? {
        goal: rec.plan.goal || '',
        steps: (rec.plan.steps || []).map((s) => ({ id: s.id, task: (s.task || '').slice(0, 140), produces: s.produces || '', parallel: !!s.parallel, status: s.status })),
        merge: (rec.plan.merge || '').slice(0, 200),
        replans: rec.plan.replans || 0,
        escalatedToUser: !!rec.plan.escalated,
        completed: rec.plan.completed !== false,
        varsCaptured: rec.plan.vars || 0
      } : null
    },
    tools: {
      offered: L.toolCount || 0,
      results: (rec.toolTurns || []).map((t) => ({ name: String(t.name).split('__').pop(), tokens: t.resultTokens, truncated: !!t.truncated }))
    },
    delegations: (rec.process || []).map((p) => ({ agent: p.agent, absorbedTokens: p.inputTokens, returnedTokens: p.conclusionTokens, tools: p.tools })),
    request: cur ? (cur.content || '').slice(0, 500) : ''
  };
}

async function runEvaluate() {
  const rec = state.internals[state.currentChatId];
  if (!rec || !rec.ledger) return;
  const model = state.evaluatorModel || state.selected?.model;
  if (!model) { rec.review = { error: 'no evaluator model selected', findings: [] }; renderReview(rec); return; }
  const prov = resolveProvider(model);
  if (!prov.providerId) { rec.review = { error: `no connection for ${model}`, findings: [] }; renderReview(rec); return; }
  rec.review = { running: true, findings: [] };
  renderReview(rec);
  try {
    const res = await window.api.evaluate.run({ providerId: prov.providerId, model, digest: buildDigest(rec) });
    rec.review = { running: false, assessment: res.assessment || '', findings: res.findings || [], error: res.error, raw: res.raw };
  } catch (e) { rec.review = { running: false, error: e?.message || 'failed', findings: [] }; }
  renderReview(rec);
}

function turn(text, role, model) {
  const div = document.createElement('div');
  if (role === 'meta') {
    div.className = 'turn turn--meta';
    div.innerHTML = `<div class="turn__body">${escapeHtml(text)}</div>`;
  } else {
    const who = role === 'user' ? 'YOU' : whoLabel(model || state.selected?.model);
    div.className = `turn turn--${role}`;
    div.innerHTML = `<div class="turn__who turn__who--${role}">${escapeHtml(who)}</div><div class="turn__body"></div>`;
    const bodyEl = div.querySelector('.turn__body');
    if (role === 'assistant') { renderAssistantBody(bodyEl, text || ''); div._copyText = text || ''; addCopyBtn(div); }
    else bodyEl.textContent = text;
  }
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
  return div;
}
// Claude-style action row at the BOTTOM of each assistant reply:
// copy · thumbs up · thumbs down · retry. Ratings persist on the message row
// (O14: user judgment lands beside the turn's metrics).
async function resolveMessageId(div) {
  if (div._messageId) return div._messageId;
  // Live-streamed bubbles don't know their row id — the reply was persisted
  // main-side at turn end, so the last assistant row is this bubble.
  try {
    const list = await window.api.messages.list(state.currentChatId);
    const last = [...list].reverse().find((m) => m.role === 'assistant');
    if (last) div._messageId = last.id;
  } catch {}
  return div._messageId || null;
}
function setRatingUI(row, rating) {
  row.querySelector('[data-act="up"]').classList.toggle('is-active', rating === 1);
  row.querySelector('[data-act="down"]').classList.toggle('is-active', rating === -1);
}
function addCopyBtn(div) {
  if (div.querySelector('.turnactions')) return;
  const row = document.createElement('div');
  row.className = 'turnactions';
  row.innerHTML = `
    <button type="button" data-act="copy" title="Copy response">⧉</button>
    <button type="button" data-act="up" title="Good response">👍</button>
    <button type="button" data-act="down" title="Bad response">👎</button>
    <button type="button" data-act="retry" title="Retry — send the request again">↻</button>`;
  const btn = (a) => row.querySelector(`[data-act="${a}"]`);
  btn('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(div._copyText || '');
      btn('copy').textContent = '✓';
      setTimeout(() => { btn('copy').textContent = '⧉'; }, 1200);
    } catch {}
  };
  const rate = async (value) => {
    const id = await resolveMessageId(div);
    if (!id) return;
    const next = div._rating === value ? null : value;   // click again clears
    div._rating = next;
    try { await window.api.messages.rate(id, next); } catch {}
    setRatingUI(row, next);
  };
  btn('up').onclick = () => rate(1);
  btn('down').onclick = () => rate(-1);
  btn('retry').onclick = () => {
    if (el.send.dataset.mode === 'stop') return;   // a turn is running
    const users = document.querySelectorAll('.turn--user .turn__body');
    const lastUser = users.length ? users[users.length - 1].textContent : '';
    if (!lastUser.trim()) return;
    el.input.value = lastUser;
    autosize();
    submit();
  };
  setRatingUI(row, div._rating || null);
  div.appendChild(row);
  return row;
}

function toolChips(turnEl, trace) {
  if (!trace || !trace.length) return;
  const row = document.createElement('div');
  row.className = 'toolchips';
  for (const t of trace) {
    const chip = document.createElement('span');
    chip.className = 'toolchip' + (t.ok ? '' : ' toolchip--err');
    // Show the bare tool name (strip the server prefix) for readability.
    const label = String(t.name).split('__').pop();
    chip.textContent = `${t.ok ? '⚙' : '⚠'} ${label}`;
    chip.title = t.name;
    row.appendChild(chip);
  }
  // Append INSIDE the body (a normal block); appending to the flex .turn row
  // stretched the chips into tall columns.
  (turnEl.querySelector('.turn__body') || turnEl).appendChild(row);
}
function attachChipsOnTurn(turnEl, attached) {
  const row = document.createElement('div');
  row.className = 'toolchips';
  for (const a of attached) {
    const c = document.createElement('span');
    c.className = 'toolchip toolchip--file';
    c.textContent = `📎 ${a.name.replace(/ \(truncated\)$/, '')}`;
    row.appendChild(c);
  }
  (turnEl.querySelector('.turn__body') || turnEl).appendChild(row);
}

function renderMessages(messages) {
  el.messages.innerHTML = '';
  if (messages.length === 0) { turn('NEW CHAT · MESSAGES SAVED TO THIS PROJECT', 'meta'); return; }
  for (const m of messages) {
    let meta = null; try { meta = m.metadata ? JSON.parse(m.metadata) : null; } catch {}
    const t = turn(m.content, m.role === 'user' ? 'user' : 'assistant', meta && meta.model);
    if (m.role !== 'user') {
      t._messageId = m.id;
      t._rating = m.rating === 1 || m.rating === -1 ? m.rating : null;
      const row = t.querySelector('.turnactions');
      if (row) setRatingUI(row, t._rating);
      if (meta && meta.tools) toolChips(t, meta.tools);
    }
  }
}

// ── Data flow ─────────────────────────────────────────────────────
async function loadProviders() {
  state.registry = await window.api.providers.registry();
  state.providers = await window.api.providers.list();
  if (!state.selected) state.selected = await initialSelection();
  if (state.selected) el.modelLabel.textContent = state.selected.model;
  try { state.evaluatorModel = await window.api.settings.get('evaluator_model'); } catch { /* optional */ }
  buildModelMenu();
  updateComposerMeta();
}

// Boot default: the last model the user actually used, then any enabled model.
async function initialSelection() {
  try {
    const last = await window.api.settings.get('last_model');
    if (last) { const r = resolveProvider(last); if (r.providerId) return r; }
  } catch { /* fall through to default */ }
  return defaultSelection();
}

async function loadProjects() {
  state.projects = await window.api.projects.list();
  renderProjects();
}

async function selectProject(id) {
  state.currentProjectId = id;
  state.currentChatId = null;
  const project = state.projects.find((p) => p.id === id);
  el.tbName.textContent = (project ? project.name : 'Agnostic Chat').toUpperCase();
  el.newChatBtn.disabled = false;
  el.tabbar.hidden = false;
  renderProjects();

  state.chats = await window.api.chats.list(id);
  // Bootstrap the canonical doc set (SPEC/DESIGN/PSEUDOCODE/KNOWLEDGE) so the
  // DOCUMENTS tab always shows the project's documentation structure.
  try { await window.api.documents.ensureCanonical(id); } catch {}
  state.documents = await window.api.documents.list(id);
  await loadSkills();
  await loadAgents();
  try { state.projectMcpIds = new Set((await window.api.mcp.enabledForProject(id)).map((s) => s.id)); } catch {}
  renderScope();
  renderChats(); renderDocs();
  showPage('chat');
  updateModelSwitch();

  if (state.chats.length > 0) selectChat(state.chats[0].id);
  else { el.messages.innerHTML = ''; turn('NO CHATS YET · HIT + NEXT TO CHATS', 'meta'); el.send.disabled = true; updateCodeToggle(); }
}

async function selectChat(id) {
  state.currentChatId = id;
  el.send.disabled = false;
  const chat = state.chats.find((c) => c.id === id);
  if (chat?.model) { state.selected = resolveProvider(chat.model); el.modelLabel.textContent = chat.model; }
  updateCodeToggle();
  updateComposerMeta();
  updateModelSwitch();
  renderVars();
  updateCtxMeter();
  renderChats();
  showPage('chat');
  renderMessages(await window.api.messages.list(id));
  el.input.focus();
}

async function createProject(name) {
  const project = await window.api.projects.create({ name });
  await loadProjects();
  selectProject(project.id);
}
async function createChat() {
  if (!state.currentProjectId) return;
  // New chats start on the project's preferred model, else the last-used one.
  const proj = state.projects.find((p) => p.id === state.currentProjectId);
  const model = (proj && proj.preferred_model) || state.selected?.model || null;
  const chat = await window.api.chats.create({ projectId: state.currentProjectId, title: 'New chat', model });
  state.chats = await window.api.chats.list(state.currentProjectId);
  renderChats();
  selectChat(chat.id);
}
async function createDocument(title) {
  if (!state.currentProjectId) return;
  await window.api.documents.create({ projectId: state.currentProjectId, title, source: 'user' });
  state.documents = await window.api.documents.list(state.currentProjectId);
  renderDocs();
}

// ── File attachments ──────────────────────────────────────────────
const ATTACH_MAX = 400000; // ~100k tokens cap per file
const TEXTY = /\.(md|markdown|txt|text|html?|json|jsonl|csv|tsv|xml|ya?ml|log|py|js|ts|tsx|jsx|sh|sql|css|toml|ini|conf|rs|go|java|rb|c|h|cpp|diff|patch)$/i;
function fmtSize(n) { return n < 1024 ? n + 'B' : n < 1048576 ? Math.round(n / 1024) + 'KB' : (n / 1048576).toFixed(1) + 'MB'; }

function readAttachments(fileList) {
  for (const file of Array.from(fileList || [])) {
    const texty = TEXTY.test(file.name) || /^text\//.test(file.type) || file.type === 'application/json';
    if (!texty) { flashComposer(`skipped ${file.name} — text files only for now`); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      let content = String(reader.result || '');
      let note = '';
      if (content.length > ATTACH_MAX) { content = content.slice(0, ATTACH_MAX); note = ' (truncated)'; }
      state.attachments.push({ name: file.name + note, content, size: file.size });
      renderAttachChips();
    };
    reader.readAsText(file);
  }
}
const DIR_SKIP = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.cache|__pycache__|\.venv)(\/|$)/;
function readDirAttachments(fileList) {
  const files = Array.from(fileList || [])
    .filter((f) => !DIR_SKIP.test(f.webkitRelativePath || f.name))
    .slice(0, 40);
  if (!files.length) { flashComposer('no readable files in that folder'); return; }
  for (const f of files) {
    // Preserve the folder structure in the name — a design folder's layout is
    // part of the reference.
    try { Object.defineProperty(f, 'name', { value: f.webkitRelativePath || f.name, configurable: true }); } catch {}
  }
  readAttachments(files);
}

function renderAttachChips() {
  el.composerAttach.innerHTML = '';
  el.composerAttach.hidden = state.attachments.length === 0;
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'attachchip';
    chip.innerHTML = `📎 ${escapeHtml(a.name)} <span class="attachchip__sz">${fmtSize(a.size)}</span> <button class="attachchip__x" type="button" title="Remove">✕</button>`;
    chip.querySelector('.attachchip__x').onclick = () => { state.attachments.splice(i, 1); renderAttachChips(); };
    el.composerAttach.appendChild(chip);
  });
}
function flashComposer(msg) { el.composerScope.textContent = msg; setTimeout(updateComposerMeta, 2500); }

// What's needed before a turn can actually reach a model: an assigned model
// and (since agents/tools operate relative to it) a project working directory.
// Returns [] when ready to send.
function missingPrereqs() {
  const missing = [];
  if (!state.selected?.providerId || !state.selected?.model) missing.push('model');
  const proj = state.projects.find((p) => p.id === state.currentProjectId);
  if (!proj || !proj.working_dir) missing.push('workingDir');
  return missing;
}
function showSetupNotice(missing) {
  const note = document.createElement('div');
  note.className = 'turn turn--setup';
  const items = [];
  if (missing.includes('model')) items.push('<div>No model is assigned to this chat.<button type="button" class="linkbtn" data-fix="model">Choose a model</button></div>');
  if (missing.includes('workingDir')) items.push('<div>This project has no working directory set.<button type="button" class="linkbtn" data-fix="dir">Set working directory</button></div>');
  note.innerHTML = `<div class="turn__body"><div class="setup__title">SETUP NEEDED</div>${items.join('')}</div>`;
  el.messages.appendChild(note);
  el.messages.scrollTop = el.messages.scrollHeight;
  const modelBtn = note.querySelector('[data-fix="model"]');
  if (modelBtn) modelBtn.onclick = () => toggleModelMenu(true);
  const dirBtn = note.querySelector('[data-fix="dir"]');
  if (dirBtn) dirBtn.onclick = async () => {
    if (!state.currentProjectId) return;
    const r = await window.api.projects.pickWorkingDir(state.currentProjectId);
    if (r && r.ok) {
      const i = state.projects.findIndex((p) => p.id === state.currentProjectId);
      if (i >= 0) state.projects[i] = r.project;
      renderOverview();
    }
  };
}

// ── O7 alignment decisions as an interactive form ──────────────────
// One selectable option row per decision plus a write-in ("Other"), submitted
// as a single composed reply through the normal send path — so O8 decision
// recording works unchanged. First of the feedback shapes; more (multi-select,
// ranking) can ride the same align-form event.
function renderAlignForm(body, ev) {
  const form = document.createElement('div');
  form.className = 'alignform';
  const picks = new Array(ev.decisions.length).fill(null);
  const short = (o) => String(o).split(' — ')[0].split(' - ')[0].trim();
  ev.decisions.forEach((d, i) => {
    const q = document.createElement('div'); q.className = 'alignform__q';
    q.textContent = `${i + 1}. ${d.question}`;
    form.appendChild(q);
    const opts = document.createElement('div'); opts.className = 'alignform__opts';
    const btns = [];
    const select = (btn, value) => { btns.forEach((b) => b.classList.remove('is-picked')); if (btn) btn.classList.add('is-picked'); picks[i] = value; };
    for (const o of (d.options || [])) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'alignform__opt';
      b.textContent = o;
      // Dashed outline marks the model's recommendation — a hint, not a pick.
      if (d.recommendation && d.recommendation.toLowerCase().includes(short(o).toLowerCase())) b.classList.add('is-rec');
      b.onclick = () => select(b, short(o));
      btns.push(b); opts.appendChild(b);
    }
    const wrap = document.createElement('div'); wrap.className = 'alignform__writein';
    const wb = document.createElement('button'); wb.type = 'button'; wb.className = 'alignform__opt'; wb.textContent = 'OTHER:';
    const wi = document.createElement('input');
    wi.placeholder = 'write in your own…';
    const writeSelect = () => { if (wi.value.trim()) select(wb, wi.value.trim()); };
    wb.onclick = () => { wi.focus(); writeSelect(); };
    wi.oninput = writeSelect;
    btns.push(wb);
    wrap.appendChild(wb); wrap.appendChild(wi); opts.appendChild(wrap);
    form.appendChild(opts);
    if (d.recommendation) { const r = document.createElement('div'); r.className = 'alignform__rec'; r.textContent = '★ ' + d.recommendation; form.appendChild(r); }
  });
  const go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn--brand btn--sm'; go.textContent = 'USE THESE CHOICES';
  go.onclick = () => {
    const parts = [];
    ev.decisions.forEach((d, i) => { if (picks[i]) parts.push(`${i + 1}: ${picks[i]}`); });
    if (!parts.length) return;
    el.input.value = parts.join('; ');
    autosize();
    form.remove();          // the markdown reply above stays as the durable record
    submit();
  };
  const bar = document.createElement('div'); bar.className = 'alignform__bar'; bar.appendChild(go);
  form.appendChild(bar);
  body.appendChild(form);
  el.messages.scrollTop = el.messages.scrollHeight;
}

async function submit() {
  if (el.send.dataset.mode === 'stop') return; // a turn is running — the button is the stop control
  const text = el.input.value.trim();
  if ((!text && !state.attachments.length) || !state.currentChatId) return;
  const missing = missingPrereqs();
  if (missing.length) { showSetupNotice(missing); return; }
  const attached = state.attachments.slice();
  state.attachments = []; renderAttachChips();
  const userTurn = turn(text || '📎 (attached files)', 'user');
  if (attached.length) attachChipsOnTurn(userTurn, attached);
  el.input.value = ''; autosize();
  // The SEND button morphs into the stop control for the running turn — same
  // button, same look; clicking it aborts + saves work (main persists
  // variables, step results, and metrics for what ran).
  el.send.dataset.mode = 'stop';
  el.send.textContent = '⏹ STOP & SAVE';
  document.documentElement.classList.add('busy');
  await window.api.messages.add({ chatId: state.currentChatId, role: 'user', content: text });
  // Keep attachments as project documents so they persist + appear in the rail.
  if (attached.length && state.currentProjectId) {
    // Written to disk (not just indexed) so the coding tools can actually open
    // them, and so the paths can be handed to the planner with this turn.
    for (const a of attached) {
      try {
        const r = await window.api.documents.saveUpload({ projectId: state.currentProjectId, name: a.name, content: a.content });
        if (r && r.path) a.path = r.path;
      } catch {}
    }
    state.documents = await window.api.documents.list(state.currentProjectId); renderDocs();
  }

  const model = state.selected?.model;
  const thinking = turn('', 'assistant', model);
  const body = thinking.querySelector('.turn__body');
  const dots = document.createElement('span'); dots.className = 'typing'; dots.innerHTML = '<span></span><span></span><span></span>';
  const status = document.createElement('span'); status.className = 'turn__status';
  body.appendChild(dots); body.appendChild(status);
  const shortTool = (n) => String(n).split('__').pop();
  planReset();
  let streamed = '';
  let alignEv = null; // structured O7 decisions — rendered as a form after the reply lands
  const nearBottom = () => el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
  // Mid-turn "tool-call limit reached" prompt: let the user grant more steps.
  function showLimitPrompt(iterations) {
    status.textContent = '';
    const prompt = document.createElement('div');
    prompt.className = 'limitprompt';
    prompt.innerHTML = `<span class="limitprompt__msg">Reached ${iterations} tool steps without finishing — keep going?</span>`;
    const cont = document.createElement('button'); cont.className = 'btn btn--brand btn--sm'; cont.textContent = 'CONTINUE +10';
    const stop = document.createElement('button'); stop.className = 'btn btn--ghost btn--sm'; stop.textContent = 'STOP & SUMMARIZE';
    const answer = (more) => { window.api.continueChat(more); prompt.remove(); status.textContent = more ? 'continuing…' : 'summarizing…'; };
    cont.onclick = () => answer(10);
    stop.onclick = () => answer(0);
    prompt.appendChild(cont); prompt.appendChild(stop);
    body.appendChild(prompt);
    el.messages.scrollTop = el.messages.scrollHeight;
  }
  // Stuck-plan escalation (decision #1): re-plans are exhausted — explain what
  // is stuck and ask approval to keep trying (same chat:continue channel).
  function showStuckPrompt(ev) {
    status.textContent = '';
    const prompt = document.createElement('div');
    prompt.className = 'limitprompt';
    const step = (ev.step || '').slice(0, 160);
    prompt.innerHTML = `<span class="limitprompt__msg">Stuck after ${ev.replans || 0} re-plan${ev.replans === 1 ? '' : 's'}`
      + (ev.goal ? ` while working on “${escapeHtml((ev.goal || '').slice(0, 120))}”` : '')
      + (step ? ` — blocked at: ${escapeHtml(step)}` : '') + `. Keep trying?</span>`;
    const cont = document.createElement('button'); cont.className = 'btn btn--brand btn--sm'; cont.textContent = 'KEEP TRYING';
    const stop = document.createElement('button'); stop.className = 'btn btn--ghost btn--sm'; stop.textContent = 'STOP & SUMMARIZE';
    const answer = (more) => { window.api.continueChat(more); prompt.remove(); status.textContent = more ? 'continuing…' : 'summarizing…'; };
    cont.onclick = () => answer(1);
    stop.onclick = () => answer(0);
    prompt.appendChild(cont); prompt.appendChild(stop);
    body.appendChild(prompt);
    el.messages.scrollTop = el.messages.scrollHeight;
  }
  // Coding mode: per-action approval for mutations (writes/edits/shell) over
  // the same one-shot chat:continue channel. BYPASS (stop asking for this
  // project) is only offered when the working dir has git — rollback exists.
  function showActionPrompt(ev) {
    status.textContent = '';
    const prompt = document.createElement('div');
    prompt.className = 'limitprompt';
    const msg = ev.kind === 'shell'
      ? 'Run this shell command in the working directory?'
      : 'Allow this file change?';
    prompt.innerHTML = `<span class="limitprompt__msg">${msg}</span>`
      + `<code class="shellcmd">${escapeHtml(String(ev.summary || '').slice(0, 600))}</code>`;
    const allow = document.createElement('button'); allow.className = 'btn btn--brand btn--sm'; allow.textContent = 'ALLOW';
    const deny = document.createElement('button'); deny.className = 'btn btn--ghost btn--sm'; deny.textContent = 'DENY';
    const answer = (more) => { window.api.continueChat(more); prompt.remove(); status.textContent = more ? 'continuing…' : 'action skipped…'; };
    allow.onclick = () => answer(1);
    deny.onclick = () => answer(0);
    prompt.appendChild(allow); prompt.appendChild(deny);
    const makeBypassBtn = () => {
      const bypass = document.createElement('button'); bypass.className = 'btn btn--ghost btn--sm'; bypass.textContent = 'BYPASS (GIT ROLLBACK)';
      bypass.title = 'Allow this and stop asking for this project — available because the working directory is a git repo, so changes can be rolled back';
      bypass.onclick = async () => { try { await window.api.settings.set('coding_bypass', '1', state.currentProjectId); } catch {} answer(1); updateBypassChip(); };
      return bypass;
    };
    if (ev.gitAvailable) {
      prompt.appendChild(makeBypassBtn());
    } else {
      // Ask, don't just refuse: initialize git right here — the pending
      // approval stays open, and main re-checks git on every gate decision.
      const init = document.createElement('button'); init.className = 'btn btn--ghost btn--sm'; init.textContent = 'INITIALIZE GIT';
      init.title = 'Create a git repo in the working directory — file writes then flow without prompts, and bypass becomes available';
      const note = document.createElement('span');
      note.className = 'limitprompt__msg limitprompt__msg--dim';
      note.textContent = 'No git repo — writes ask every time and bypass is unavailable.';
      init.onclick = async () => {
        init.disabled = true; init.textContent = 'initializing…';
        const r = await window.api.projects.gitInit(state.currentProjectId);
        if (r && r.ok) {
          init.remove();
          note.textContent = '✓ git initialized — writes now flow free; bypass available:';
          prompt.appendChild(makeBypassBtn());
        } else {
          init.disabled = false; init.textContent = 'INITIALIZE GIT';
          note.textContent = `git init failed: ${(r && r.error) || 'unknown'}`;
        }
      };
      prompt.appendChild(init);
      prompt.appendChild(note);
    }
    body.appendChild(prompt);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  const unsub = window.api.onChatProgress((ev) => {
    if (ev.type === 'token') {
      streamed += ev.text;
      const stick = nearBottom();
      streamRender(body, streamed); // prose live; html/svg buffered as placeholders
      if (stick) el.messages.scrollTop = el.messages.scrollHeight;
    } else if (ev.type === 'model') { if (!streamed) status.textContent = 'thinking…'; }
    else if (ev.type === 'process' && ev.kind === 'planning') { if (!streamed) status.textContent = 'deriving plan…'; }
    else if (ev.type === 'process' && ev.kind === 'planning-done') { if (!streamed) status.textContent = ev.steps ? `plan: ${ev.steps} steps` : 'thinking…'; }
    else if (ev.type === 'tool-start') { if (!streamed) status.textContent = `running ${shortTool(ev.name)}…`; }
    else if (ev.type === 'limit') { showLimitPrompt(ev.iterations); }
    else if (ev.type === 'stuck') { showStuckPrompt(ev); }
    else if (ev.type === 'action-approve') { showActionPrompt(ev); }
    else if (ev.type === 'align-form') { alignEv = ev; }
    else if (ev.type === 'stream-reset') { streamed = ''; }  // synthesis begins — steps streamed above were working text, not the reply
    else if (ev.type === 'internals') { captureInternals(ev); }
    else if (ev.type === 'internals-tools') { captureInternalsTools(ev); }
    else if (ev.type === 'tool-end') { captureInternalsToolEnd(ev); }
    else if (ev.type === 'process') { captureProcess(ev); }
    else if (ev.type === 'metrics') { captureMetrics(ev); }
    else if (ev.type === 'document-saved') { onDocumentSaved(ev); }
    planEvent(ev);
  });

  try {
    const history = (await window.api.messages.list(state.currentChatId)).map((m) => ({ role: m.role, content: m.content }));
    if (attached.length && history.length) {
      const block = attached.map((a) => `\n\n[Attached file: ${a.name}${a.path ? ` — saved at ${a.path}` : ''}]\n\`\`\`\n${a.content}\n\`\`\``).join('');
      const last = history[history.length - 1];
      history[history.length - 1] = { ...last, content: (last.content || '') + block };
    }
    const res = await window.api.sendMessage({ providerId: state.selected?.providerId, model, messages: history, text, projectId: state.currentProjectId, chatId: state.currentChatId, attachments: attached.map((a) => ({ name: a.name, path: a.path || null, chars: (a.content || '').length })) });
    if (res.compressed) {
      const note = document.createElement('div');
      note.className = 'turn turn--meta';
      note.innerHTML = '<div class="turn__body">⚡ EARLIER HISTORY COMPRESSED TO SAVE CONTEXT</div>';
      el.messages.insertBefore(note, thinking);
    }
    clearTimeout(_streamPending);
    // Planned turns: the authoritative reply is the synthesis (res.reply);
    // streamed may hold per-step working text if stream-reset was missed.
    let finalText = ((res.planned ? res.reply : streamed) || res.reply || streamed || '(empty response)').trim();
    if (res.aborted && !res.planned) finalText += '\n\n⏹ *Stopped at your request — gathered values and tool work were saved.*';
    renderAssistantBody(body, finalText);
    thinking._copyText = finalText;
    if (!thinking.querySelector('.copybtn')) addCopyBtn(thinking);
    if (res.toolTrace && res.toolTrace.length) toolChips(thinking, res.toolTrace);
    if (alignEv && alignEv.decisions && alignEv.decisions.length) renderAlignForm(body, alignEv);
    el.messages.scrollTop = el.messages.scrollHeight;
    await window.api.messages.add({ chatId: state.currentChatId, role: 'assistant', content: finalText, metadata: { model: res.model, tools: res.toolTrace || [] } });
  } catch (err) {
    thinking.className = 'turn turn--meta';
    thinking.innerHTML = `<div class="turn__body">ERROR · ${escapeHtml(err?.message ?? 'request failed')}</div>`;
  } finally {
    unsub(); planStop(); renderVars();
    el.send.dataset.mode = ''; el.send.textContent = 'SEND'; el.send.disabled = false;
    document.documentElement.classList.remove('busy'); el.input.focus();
  }
}
function autosize() { el.input.style.height = 'auto'; el.input.style.height = `${el.input.scrollHeight}px`; }

// ── Live activity timeline (PLAN rail) ─────────────────────────────
let planTimer = null, planStart = 0, planCurrent = null, planSwitched = false;
function planReset() {
  el.planList.innerHTML = ''; el.planNote.hidden = true; planCurrent = null; planSwitched = false;
  planStart = Date.now();
  clearInterval(planTimer);
  planTimer = setInterval(() => {
    const s = Math.round((Date.now() - planStart) / 1000);
    el.planElapsed.textContent = s + 's';
    if (planCurrent) { const t = planCurrent.querySelector('.planstep__t'); if (t) t.textContent = s - planCurrent._t0 + 's'; }
  }, 500);
}
function planStop() { clearInterval(planTimer); planTimer = null; planFinalize(true); }
function planFinalize(ok) {
  if (!planCurrent) return;
  planCurrent.classList.remove('planstep--run');
  planCurrent.classList.add(ok ? 'planstep--done' : 'planstep--fail');
  planCurrent = null;
}
function planAdd(label) {
  planFinalize(true);
  const li = document.createElement('li');
  li.className = 'planstep planstep--run';
  li._t0 = Math.round((Date.now() - planStart) / 1000);
  li.innerHTML = `<span class="planstep__dot"></span><span class="planstep__label">${escapeHtml(label)}</span><span class="planstep__t"></span>`;
  el.planList.appendChild(li); el.planList.scrollTop = el.planList.scrollHeight;
  planCurrent = li;
  return li;
}
function planEvent(ev) {
  if (ev.type === 'model') planAdd('thinking…');
  else if (ev.type === 'tool-start') { if (!planSwitched) { showRail('plan'); planSwitched = true; } planAdd('⚙ ' + String(ev.name).split('__').pop()); }
  else if (ev.type === 'tool-end') planFinalize(ev.ok !== false);
  else if (ev.type === 'done') planFinalize(true);
  else if (ev.type === 'process') {
    // Plan-and-execute narration in the live rail.
    if (ev.kind === 'planning') { if (!planSwitched) { showRail('plan'); planSwitched = true; } planAdd(`◈ deriving plan (${ev.model || 'fast model'})…`); }
    else if (ev.kind === 'planning-done') planFinalize(!ev.error);
    else if (ev.kind === 'plan') { planAdd(`◈ plan: ${(ev.steps || []).length} steps`); planFinalize(true); }
    else if (ev.kind === 'step-start') planAdd(`▸ step ${ev.step}${ev.group ? ` ⑃ ${ev.group}` : ''}: ${(ev.task || '').slice(0, 60)}`);
    else if (ev.kind === 'group-start') planAdd(`⑃ fan-out "${ev.group}": ${(ev.steps || []).length} tasks concurrent`);
    else if (ev.kind === 'group-merge') planAdd(`⑃ merging "${ev.group}" (${ev.members} results)`);
    else if (ev.kind === 'group-merged') planAdd(`⑃ group "${ev.group}" → one result${ev.merged ? '' : ' (concatenated — merge unavailable)'}`);
    else if (ev.kind === 'step-done') planFinalize(true);
    else if (ev.kind === 'step-stuck') planFinalize(false);
    else if (ev.kind === 'replan') { planAdd(`↻ re-planning (${ev.attempt}/3)…`); }
    else if (ev.kind === 'escalate') planFinalize(false);
    else if (ev.kind === 'coding-mode') { planAdd(`⌥ coding harness: ${ev.tools || 0} tools${ev.gitAvailable ? ' · git' : ' · no git'}`); planFinalize(true); }
    else if (ev.kind === 'documents-mode') { planAdd(`⌥ documents harness: ${ev.tools || 0} library tools${ev.formatTarget ? ` · format target: ${ev.formatTarget}` : ''}`); planFinalize(true); }
    else if (ev.kind === 'review') { planAdd(`⚖ reviewing ${ev.files} changed file${ev.files === 1 ? '' : 's'} (quality · security)…`); }
    else if (ev.kind === 'review-clean') { planFinalize(true); planAdd('⚖ review clean'); planFinalize(true); }
    else if (ev.kind === 'review-findings') { planFinalize(false); planAdd(`⚖ ${ev.count} finding${ev.count === 1 ? '' : 's'} — fixing…`); }
    else if (ev.kind === 'review-fixed') { planFinalize(true); }
    else if (ev.kind === 'doc-writer') { planAdd('✎ maintaining documentation…'); }
    else if (ev.kind === 'doc-update') { planAdd(`✎ ${String(ev.doc || 'doc').toUpperCase()} updated → v${ev.version}`); planFinalize(true); }
    else if (ev.kind === 'align') { planAdd(`◈ alignment needed — ${ev.decisions} decision${ev.decisions === 1 ? '' : 's'} for you`); planFinalize(true); }
    else if (ev.kind === 'step-commit') { planAdd('✓ committed — ' + String(ev.message || '').slice(0, 48)); planFinalize(true); }
  }
}

// ── Models screen ─────────────────────────────────────────────────
function showModels() {
  el.pages.querySelectorAll('.page').forEach((s) => { s.hidden = s.dataset.page !== 'models'; });
  el.tabbar.querySelectorAll('.tab').forEach((b) => b.classList.remove('is-active'));
  el.tbSlug.textContent = '/ models';
  renderModels();
  closeEditor();
}
function leaveModels() {
  if (state.currentProjectId) showPage('chat');
  else showFirstRun();
}

function providerDef(type) { return state.registry.find((r) => r.type === type); }

function renderModels() {
  el.connList.innerHTML = '';
  el.connEmpty.hidden = state.providers.length > 0;
  for (const p of state.providers) {
    const def = providerDef(p.type);
    const li = document.createElement('li');
    li.className = 'conn';
    const statusCls = p.status === 'ok' ? ' conn__status--ok' : p.status === 'error' ? ' conn__status--error' : '';
    li.innerHTML = `
      <span class="conn__status${statusCls}" title="${escapeHtml(p.status_detail || p.status || 'untested')}"></span>
      <div class="conn__info">
        <div class="conn__label">${escapeHtml(p.label || (def ? def.label : p.type))}${p.has_secret ? '' : ' <span class="conn__nokey">NO KEY</span>'}</div>
        <div class="conn__type">${escapeHtml(p.type)}${p.models && p.models.length ? ' · ' + p.models.length + ' models' : ''}</div>
      </div>
      <div class="conn__mid">
        <div class="conn__url">${escapeHtml(p.base_url || (def ? def.baseUrl : ''))}</div>
        <div class="conn__model">${escapeHtml(p.default_model || 'no default model')}</div>
      </div>
      <div class="conn__actions"></div>`;
    const actions = li.querySelector('.conn__actions');

    const toggle = document.createElement('button');
    toggle.className = 'toggle' + (p.enabled ? ' is-on' : '');
    toggle.innerHTML = '<div class="toggle__knob"></div>';
    toggle.title = p.enabled ? 'Enabled' : 'Disabled';
    toggle.onclick = async () => { await window.api.providers.update(p.id, { enabled: !p.enabled }); await refreshProviders(); };
    actions.appendChild(toggle);

    const helpBtn = document.createElement('button');
    helpBtn.className = 'conn__btn'; helpBtn.textContent = 'ⓘ'; helpBtn.title = 'How to get / manage this key';
    helpBtn.onclick = () => openHelp(p.type);
    actions.appendChild(helpBtn);

    const testBtn = document.createElement('button');
    testBtn.className = 'conn__btn'; testBtn.textContent = 'TEST';
    testBtn.onclick = async () => {
      if (!p.has_secret) { openEditor(p.id); el.testResult.textContent = 'add an API key, then TEST'; el.testResult.className = 'test-result test-result--error'; return; }
      testBtn.textContent = '…';
      try {
        const r = await window.api.providers.test({ id: p.id });
        testBtn.textContent = r.ok ? 'OK' : 'FAIL';
        if (!r.ok) console.log('[test row] fail', r.error);
        await refreshProviders();
      } catch (err) {
        console.error('[test row] threw', err && (err.stack || err.message || String(err)));
        testBtn.textContent = 'ERR';
        setTimeout(() => { testBtn.textContent = 'TEST'; }, 1500);
      }
    };
    actions.appendChild(testBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'conn__btn'; editBtn.textContent = 'EDIT';
    editBtn.onclick = () => openEditor(p.id);
    actions.appendChild(editBtn);

    const rm = document.createElement('button');
    rm.className = 'conn__btn conn__btn--danger'; rm.textContent = 'REMOVE';
    rm.onclick = async () => { await window.api.providers.remove(p.id); await refreshProviders(); };
    actions.appendChild(rm);

    el.connList.appendChild(li);
  }
}

async function refreshProviders() {
  state.providers = await window.api.providers.list();
  if (state.selected && !state.providers.some((p) => p.id === state.selected.providerId && p.enabled)) {
    state.selected = defaultSelection();
    el.modelLabel.textContent = state.selected?.model || 'no model';
  }
  buildModelMenu(); updateComposerMeta(); renderModels();
}

function buildTypeMenu() {
  el.typeMenu.innerHTML = '';
  for (const r of state.registry) {
    const b = document.createElement('button');
    b.className = 'dropdown__item'; b.type = 'button';
    const on = state.editorType === r.type;
    b.innerHTML = `<span class="tick">${on ? '›' : ''}</span>${escapeHtml(r.label)}`;
    b.onclick = () => selectType(r.type);
    el.typeMenu.appendChild(b);
  }
}
function toggleTypeMenu(force) { const show = force ?? el.typeMenu.hidden; if (show) buildTypeMenu(); el.typeMenu.hidden = !show; }
function selectType(type) {
  state.editorType = type;
  el.typeLabel.textContent = providerDef(type)?.label || type;
  toggleTypeMenu(false);
  state.testedModels = null;
  applyTypeDefaults(type, { force: true });
}
function applyTypeDefaults(type, { force } = {}) {
  const def = providerDef(type);
  if (!def) return;
  if (force || !el.fBaseurl.value) el.fBaseurl.value = def.baseUrl;
  el.fSecretHint.textContent = `Key format ${def.keyHint} · encrypted in Keychain, never shown again`;
  state.modelOptions = (state.testedModels && state.testedModels.length) ? state.testedModels : (def.fallbackModels || []);
  buildModelSuggest();
}

// Default-model combobox (custom — pick from list, or type any id)
function buildModelSuggest() {
  const q = el.fModel.value.trim().toLowerCase();
  const opts = state.modelOptions.filter((m) => m.toLowerCase().includes(q));
  el.fModelMenu.innerHTML = '';
  for (const m of opts.slice(0, 60)) {
    const b = document.createElement('button');
    b.className = 'dropdown__item'; b.type = 'button';
    b.innerHTML = `<span class="tick">${el.fModel.value === m ? '›' : ''}</span>${escapeHtml(m)}`;
    b.onmousedown = (e) => { e.preventDefault(); el.fModel.value = m; closeModelSuggest(); };
    el.fModelMenu.appendChild(b);
  }
  if (!opts.length) el.fModelMenu.hidden = true;
}
function openModelSuggest() { buildModelSuggest(); if (el.fModelMenu.children.length) el.fModelMenu.hidden = false; }
function closeModelSuggest() { el.fModelMenu.hidden = true; }

// Planning-model combobox — same list as the default-model combo, but filtered
// to ids that look like a fast/small tier (mini, flash, haiku, lite, ...). This
// is the model that runs context planning (skill/tool selection), history
// compression, and sub-agent defaults — it should be cheap, not "any model
// this account can reach". Falls back to the full list when nothing matches
// (an account with no obviously-fast id shouldn't leave the field stuck empty).
const FAST_MODEL_HINT = /(?:^|[-_ ])(mini|flash|lite|nano|haiku|turbo|instant|small|fast)(?:[-_ ]|$)|[-_]\d{1,2}b(?:[-_]|$)/i;
function looksLikeFastModel(id) { return FAST_MODEL_HINT.test(id); }
function fastModelOptions() {
  const fast = state.modelOptions.filter(looksLikeFastModel);
  return fast.length ? fast : state.modelOptions;
}
function buildFastModelSuggest() {
  const q = el.fFastModel.value.trim().toLowerCase();
  const pool = fastModelOptions();
  const opts = pool.filter((m) => m.toLowerCase().includes(q));
  el.fFastModelMenu.innerHTML = '';
  for (const m of opts.slice(0, 60)) {
    const b = document.createElement('button');
    b.className = 'dropdown__item'; b.type = 'button';
    b.innerHTML = `<span class="tick">${el.fFastModel.value === m ? '›' : ''}</span>${escapeHtml(m)}`;
    b.onmousedown = (e) => { e.preventDefault(); el.fFastModel.value = m; closeFastModelSuggest(); };
    el.fFastModelMenu.appendChild(b);
  }
  if (!opts.length) el.fFastModelMenu.hidden = true;
}
function openFastModelSuggest() { buildFastModelSuggest(); if (el.fFastModelMenu.children.length) el.fFastModelMenu.hidden = false; }
function closeFastModelSuggest() { el.fFastModelMenu.hidden = true; }

function openEditor(id) {
  state.editing = id ?? null;
  state.testedModels = null;
  el.testResult.textContent = ''; el.testResult.className = 'test-result';
  el.typeMenu.hidden = true;
  if (id) {
    const p = state.providers.find((x) => x.id === id);
    el.editorTitle.textContent = 'EDIT CONNECTION';
    state.editorType = p.type;
    el.typeLabel.textContent = providerDef(p.type)?.label || p.type;
    el.fLabel.value = p.label || '';
    el.fBaseurl.value = p.base_url || (providerDef(p.type)?.baseUrl ?? '');
    el.fSecret.value = '';
    el.fSecret.placeholder = 'leave blank to keep current key';
    el.fModel.value = p.default_model || '';
    el.fFastModel.value = p.fast_model || '';
    state.testedModels = p.models || null;
    applyTypeDefaults(p.type);
  } else {
    el.editorTitle.textContent = 'ADD CONNECTION';
    const first = state.registry[0]?.type;
    state.editorType = first;
    el.typeLabel.textContent = providerDef(first)?.label || first;
    el.fLabel.value = ''; el.fSecret.value = ''; el.fSecret.placeholder = 'paste key'; el.fModel.value = ''; el.fFastModel.value = '';
    el.fBaseurl.value = '';
    applyTypeDefaults(first, { force: true });
  }
  buildTypeMenu();
  el.connEditor.hidden = false;
}
function closeEditor() { el.connEditor.hidden = true; el.typeMenu.hidden = true; state.editing = null; }

async function testEditor() {
  const type = state.editorType;
  const baseUrl = el.fBaseurl.value.trim();
  const secret = el.fSecret.value;
  const defaultModel = el.fModel.value.trim();
  console.log(`[test] click type=${type} hasSecret=${!!secret} editing=${state.editing} baseUrl=${baseUrl}`);
  el.testResult.textContent = 'testing…'; el.testResult.className = 'test-result';

  const input = secret
    ? { type, baseUrl, secret, defaultModel }
    : (state.editing ? { id: state.editing, defaultModel } : null);
  if (!input) { el.testResult.textContent = 'enter a key first'; el.testResult.className = 'test-result test-result--error'; return; }

  try {
    const r = await window.api.providers.test(input);
    console.log('[test] result', JSON.stringify(r));
    if (r.ok) {
      state.testedModels = r.models && r.models.length ? r.models : state.testedModels;
      applyTypeDefaults(type);
      if (r.models && r.models.length) openModelSuggest();
      el.testResult.textContent = r.models && r.models.length ? `ok · ${r.models.length} models` : 'ok';
      el.testResult.className = 'test-result test-result--ok';
      if (state.editing) await refreshProviders();
    } else {
      el.testResult.textContent = r.error || 'failed';
      el.testResult.className = 'test-result test-result--error';
    }
  } catch (err) {
    console.error('[test] threw', err && (err.stack || err.message || String(err)));
    el.testResult.textContent = `error: ${err?.message ?? 'request failed'}`;
    el.testResult.className = 'test-result test-result--error';
  }
}

async function saveEditor() {
  const type = state.editorType;
  const label = el.fLabel.value.trim() || null;
  const baseUrl = el.fBaseurl.value.trim() || null;
  const secret = el.fSecret.value || null;
  const defaultModel = el.fModel.value.trim() || null;
  const fastModel = el.fFastModel.value.trim() || null;

  // A key is required (new connection, or an existing one that never had one).
  const existing = state.editing ? state.providers.find((p) => p.id === state.editing) : null;
  if (!secret && (!existing || !existing.has_secret)) {
    el.testResult.textContent = 'enter an API key before saving';
    el.testResult.className = 'test-result test-result--error';
    return;
  }
  try {
    if (state.editing) {
      const patch = { label, baseUrl, defaultModel, fastModel };
      if (secret) patch.secret = secret;
      if (state.testedModels) patch.models = state.testedModels;
      await window.api.providers.update(state.editing, patch);
    } else {
      await window.api.providers.add({ type, label, baseUrl, secret, defaultModel, fastModel, enabled: true, models: state.testedModels });
    }
    closeEditor();
    await refreshProviders();
  } catch (err) {
    console.error('[save] threw', err && (err.stack || err.message || String(err)));
    el.testResult.textContent = `save failed: ${err?.message ?? 'error'}`;
    el.testResult.className = 'test-result test-result--error';
  }
}

// ── MCP servers screen ────────────────────────────────────────────
const MCP_TRANSPORTS = [{ v: 'stdio', label: 'stdio (local process)' }, { v: 'http', label: 'http (remote)' }];

function showMcp() {
  el.pages.querySelectorAll('.page').forEach((s) => { s.hidden = s.dataset.page !== 'mcp'; });
  el.tabbar.querySelectorAll('.tab').forEach((b) => b.classList.remove('is-active'));
  el.tbSlug.textContent = '/ mcp';
  renderMcpList(); closeMcpEditor();
  checkMcpSync();   // async — badges rows as results land
}
function leaveMcp() { if (state.currentProjectId) showPage('chat'); else showFirstRun(); }

async function loadMcp() { state.mcpServers = await window.api.mcp.list(); renderScope(); }
async function refreshMcp() { state.mcpServers = await window.api.mcp.list(); renderMcpList(); renderScope(); }
// Version-drift check: compare the live server (tools + skill versions)
// against what the app imported/cached. Badges the row and the titlebar MCP
// button; the badge's UPDATE action re-syncs (reconnect + skill re-import).
async function checkMcpSync() {
  try {
    const r = await window.api.mcp.checkSync();
    if (!r || !r.ok) return;
    state.mcpSync = {};
    for (const s of r.servers) state.mcpSync[s.serverId] = s;
    const anyDrift = r.servers.some((s) => s.drift);
    el.mcpBtn.classList.toggle('chip-btn--alert', anyDrift);
    el.mcpBtn.title = anyDrift ? 'An MCP server has updated skills or tools — open to refresh' : '';
    renderMcpList();
  } catch (e) { console.error('[mcp sync]', e && e.message); }
}

function renderMcpList() {
  el.mcpList.innerHTML = '';
  el.mcpEmpty.hidden = state.mcpServers.length > 0;
  for (const s of state.mcpServers) {
    const li = document.createElement('li');
    li.className = 'conn';
    const statusCls = s.status === 'ok' ? ' conn__status--ok' : s.status === 'error' ? ' conn__status--error' : '';
    const detail = s.transport === 'http' ? (s.url || '') : `${s.command || ''} ${(s.args || []).join(' ')}`.trim();
    const toolNames = (s.tools || []).map((t) => t.name).slice(0, 4).join(', ');
    const needsAuth = s.transport === 'http' && s.status === 'error' && /401|auth/i.test(s.status_detail || '');
    const subText = s.status === 'error' && s.status_detail
      ? (needsAuth ? `${s.status_detail} — click SIGN IN →` : s.status_detail)
      : (toolNames || 'no tools yet');
    const sync = (state.mcpSync || {})[s.id];
    const driftBits = sync && sync.drift
      ? [sync.skillsOutdated.length ? `${sync.skillsOutdated.length} skill update${sync.skillsOutdated.length === 1 ? '' : 's'}` : '',
         sync.toolsAdded ? `${sync.toolsAdded} new tool${sync.toolsAdded === 1 ? '' : 's'}` : '',
         sync.toolsRemoved ? `${sync.toolsRemoved} tool${sync.toolsRemoved === 1 ? '' : 's'} removed` : ''].filter(Boolean).join(' · ')
      : '';
    const driftTitle = sync && sync.skillsOutdated.length
      ? sync.skillsOutdated.map((k) => `${k.name}: v${k.local} → v${k.remote}`).join('\n') : driftBits;
    li.innerHTML = `
      <span class="conn__status${statusCls}" title="${escapeHtml(s.status_detail || s.status || 'untested')}"></span>
      <div class="conn__info"><div class="conn__label">${escapeHtml(s.name)}${driftBits ? ` <span class="conn__drift" title="${escapeHtml(driftTitle)}">⟳ ${escapeHtml(driftBits)}</span>` : ''}</div><div class="conn__type">${escapeHtml(s.transport)}${s.tools && s.tools.length ? ' · ' + s.tools.length + ' tools' : ''}</div></div>
      <div class="conn__mid"><div class="conn__url">${escapeHtml(detail)}</div><div class="conn__model${s.status === 'error' ? ' conn__model--err' : ''}">${escapeHtml(subText)}</div></div>
      <div class="conn__actions"></div>`;
    const actions = li.querySelector('.conn__actions');

    if (sync && sync.drift) {
      const upd = document.createElement('button');
      upd.className = 'conn__btn conn__btn--primary'; upd.textContent = 'UPDATE';
      upd.title = 'Re-sync with the server: refresh the tool listing and re-import updated skills';
      upd.onclick = async () => {
        upd.textContent = '…';
        try {
          await window.api.mcp.connect({ id: s.id });                 // re-cache tools
          if (sync.skillsOutdated.length) await window.api.skills.importFromMcp(s.id); // re-import skills
          upd.textContent = 'OK';
        } catch (e) { upd.textContent = 'ERR'; console.error('[mcp update]', e && e.message); }
        await refreshMcp();
        await checkMcpSync();
      };
      actions.appendChild(upd);
    }

    const toggle = document.createElement('button');
    toggle.className = 'toggle' + (s.enabled ? ' is-on' : ''); toggle.innerHTML = '<div class="toggle__knob"></div>';
    toggle.onclick = async () => { await window.api.mcp.update(s.id, { enabled: !s.enabled }); await refreshMcp(); };
    actions.appendChild(toggle);

    if (s.transport === 'http') {
      const signin = document.createElement('button');
      signin.className = 'conn__btn conn__btn--primary'; signin.textContent = 'SIGN IN'; signin.title = 'Authenticate (OAuth)';
      signin.onclick = async () => {
        signin.textContent = '…';
        try {
          const r = await window.api.mcp.authorize(s.id);
          if (r.ok) { signin.textContent = 'OK'; await window.api.mcp.connect({ id: s.id }); }
          else { signin.textContent = 'FAIL'; console.log('[mcp signin] fail', r.error); }
        } catch (e) { signin.textContent = 'ERR'; console.error('[mcp signin] threw', e && (e.stack || e.message)); }
        await refreshMcp();
        setTimeout(() => { signin.textContent = 'SIGN IN'; }, 2000);
      };
      actions.appendChild(signin);
    }

    const conn = document.createElement('button');
    conn.className = 'conn__btn'; conn.textContent = 'CONNECT';
    conn.onclick = async () => {
      conn.textContent = '…';
      try { const r = await window.api.mcp.connect({ id: s.id }); conn.textContent = r.ok ? 'OK' : 'FAIL'; if (!r.ok) console.log('[mcp row] fail', r.error); await refreshMcp(); }
      catch (e) { conn.textContent = 'ERR'; console.error('[mcp row] threw', e && (e.stack || e.message)); }
      setTimeout(() => { conn.textContent = 'CONNECT'; }, 1500);
    };
    actions.appendChild(conn);

    const edit = document.createElement('button'); edit.className = 'conn__btn'; edit.textContent = 'EDIT'; edit.onclick = () => openMcpEditor(s.id); actions.appendChild(edit);
    const rm = document.createElement('button'); rm.className = 'conn__btn conn__btn--danger'; rm.textContent = 'REMOVE'; rm.onclick = async () => { await window.api.mcp.remove(s.id); await refreshMcp(); }; actions.appendChild(rm);
    el.mcpList.appendChild(li);
  }
}

function buildTransportMenu() {
  el.mTransportMenu.innerHTML = '';
  for (const t of MCP_TRANSPORTS) {
    const b = document.createElement('button'); b.className = 'dropdown__item'; b.type = 'button';
    b.innerHTML = `<span class="tick">${state.mcpTransport === t.v ? '›' : ''}</span>${escapeHtml(t.label)}`;
    b.onclick = () => selectTransport(t.v);
    el.mTransportMenu.appendChild(b);
  }
}
function toggleTransportMenu(force) { const show = force ?? el.mTransportMenu.hidden; if (show) buildTransportMenu(); el.mTransportMenu.hidden = !show; }
function selectTransport(v) {
  state.mcpTransport = v;
  el.mTransportLabel.textContent = (MCP_TRANSPORTS.find((t) => t.v === v) || {}).label || v;
  el.mStdioFields.hidden = v !== 'stdio';
  el.mHttpFields.hidden = v !== 'http';
  toggleTransportMenu(false);
}

function openMcpEditor(id) {
  state.mcpEditing = id ?? null; state.mcpTools = null;
  el.mcpResult.textContent = ''; el.mcpResult.className = 'test-result'; el.mTransportMenu.hidden = true;
  if (id) {
    const s = state.mcpServers.find((x) => x.id === id);
    el.mcpEditorTitle.textContent = 'EDIT SERVER';
    el.mName.value = s.name || '';
    selectTransport(s.transport || 'stdio');
    el.mCommand.value = s.command || ''; el.mArgs.value = (s.args || []).join(' ');
    el.mEnv.value = ''; el.mEnv.placeholder = 'KEY=VALUE per line (blank = keep)';
    el.mUrl.value = s.url || ''; el.mToken.value = ''; el.mToken.placeholder = 'leave blank to keep';
    state.mcpTools = s.tools || null;
  } else {
    el.mcpEditorTitle.textContent = 'ADD SERVER';
    el.mName.value = ''; selectTransport('stdio');
    el.mCommand.value = ''; el.mArgs.value = ''; el.mEnv.value = ''; el.mEnv.placeholder = 'KEY=VALUE per line';
    el.mUrl.value = ''; el.mToken.value = ''; el.mToken.placeholder = 'token';
  }
  buildTransportMenu();
  el.mcpEditor.hidden = false;
}
function closeMcpEditor() { el.mcpEditor.hidden = true; el.mTransportMenu.hidden = true; state.mcpEditing = null; }

function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || !s.includes('=')) continue;
    const i = s.indexOf('=');
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return Object.keys(env).length ? env : null;
}
function parseArgs(text) { const t = text.trim(); return t ? t.split(/\s+/) : []; }

function mcpEditorConfig() {
  if (state.mcpTransport === 'http') return { transport: 'http', url: el.mUrl.value.trim(), token: el.mToken.value || undefined };
  return { transport: 'stdio', command: el.mCommand.value.trim(), args: parseArgs(el.mArgs.value), env: parseEnv(el.mEnv.value) || undefined };
}

async function connectMcp() {
  const cfg = mcpEditorConfig();
  console.log('[mcp] connect click', cfg.transport, cfg.command || cfg.url);
  el.mcpResult.textContent = 'connecting…'; el.mcpResult.className = 'test-result';
  const hasNewSecret = cfg.env || cfg.token;
  const input = hasNewSecret ? cfg : (state.mcpEditing ? { id: state.mcpEditing } : cfg);
  try {
    const r = await window.api.mcp.connect(input);
    console.log('[mcp] connect result', JSON.stringify({ ok: r.ok, tools: r.tools && r.tools.length, error: r.error }));
    if (r.ok) {
      state.mcpTools = r.tools || [];
      el.mcpResult.textContent = `ok · ${(r.tools || []).length} tools`;
      el.mcpResult.className = 'test-result test-result--ok';
      if (state.mcpEditing) await refreshMcp();
    } else {
      el.mcpResult.textContent = r.error || 'failed';
      el.mcpResult.className = 'test-result test-result--error';
    }
  } catch (err) {
    console.error('[mcp] connect threw', err && (err.stack || err.message));
    el.mcpResult.textContent = `error: ${err?.message ?? 'failed'}`;
    el.mcpResult.className = 'test-result test-result--error';
  }
}

async function saveMcp() {
  const name = el.mName.value.trim();
  if (!name) { el.mcpResult.textContent = 'enter a name'; el.mcpResult.className = 'test-result test-result--error'; return; }
  const cfg = mcpEditorConfig();
  const secret = cfg.transport === 'http' ? (cfg.token ? { token: cfg.token } : null) : (cfg.env ? { env: cfg.env } : null);
  try {
    if (state.mcpEditing) {
      const patch = { name, transport: cfg.transport, command: cfg.command || null, args: cfg.args || null, url: cfg.url || null };
      if (secret) patch.secret = secret;
      if (state.mcpTools) patch.tools = state.mcpTools;
      await window.api.mcp.update(state.mcpEditing, patch);
    } else {
      await window.api.mcp.add({ name, transport: cfg.transport, command: cfg.command || null, args: cfg.args || null, url: cfg.url || null, secret, enabled: true, tools: state.mcpTools });
    }
    closeMcpEditor(); await refreshMcp();
  } catch (err) {
    console.error('[mcp save] threw', err && (err.stack || err.message));
    el.mcpResult.textContent = `save failed: ${err?.message ?? 'error'}`;
    el.mcpResult.className = 'test-result test-result--error';
  }
}

// ── Artifact panel (embedded Chromium preview with DevTools + console) ─
const av = {
  panel: $('artifact'), splitter: $('splitter'), view: $('artifact-view'), title: $('artifact-title'),
  console: $('artifact-console'), devtools: $('artifact-devtools'), refresh: $('artifact-refresh'), close: $('artifact-close')
};
let artifactHtml = '';
const LEVELS = ['log', 'warn', 'error', 'debug'];

function loadArtifact() {
  av.view.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(artifactHtml);
}
function openArtifact(html, title) {
  artifactHtml = html;
  av.title.textContent = title || 'REPORT';
  av.console.innerHTML = '';
  av.panel.hidden = false;
  av.splitter.hidden = false;
  loadArtifact();
}
function closeArtifact() {
  av.panel.hidden = true;
  av.splitter.hidden = true;
  try { av.view.src = 'about:blank'; } catch {}
}
function addArtifactConsole(level, msg) {
  if (/Electron Security Warning|Insecure Content-Security-Policy/i.test(msg)) return; // dev-only noise
  const d = document.createElement('div');
  d.className = 'acon acon--' + (LEVELS[level] || 'log');
  d.textContent = msg;
  av.console.appendChild(d);
  av.console.scrollTop = av.console.scrollHeight;
}
if (av.view) {
  av.view.addEventListener('console-message', (e) => addArtifactConsole(e.level, e.message));
  av.view.addEventListener('did-fail-load', (e) => addArtifactConsole(2, `load failed: ${e.errorDescription || ''}`));
}
if (av.devtools) av.devtools.onclick = () => { try { av.view.openDevTools(); } catch (err) { addArtifactConsole(2, 'DevTools unavailable: ' + err.message); } };
if (av.refresh) av.refresh.onclick = () => { av.console.innerHTML = ''; loadArtifact(); };
if (av.close) av.close.onclick = closeArtifact;

// Drag the splitter to resize the artifact panel.
if (av.splitter) {
  let dragging = false;
  av.splitter.addEventListener('mousedown', (e) => { dragging = true; av.splitter.classList.add('dragging'); document.body.style.userSelect = 'none'; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = document.querySelector('.body').getBoundingClientRect();
    const w = rect.right - e.clientX;
    av.panel.style.width = Math.max(360, Math.min(w, rect.width - 380)) + 'px';
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; av.splitter.classList.remove('dragging'); document.body.style.userSelect = ''; } });
}

// ── Skills page ────────────────────────────────────────────────────
async function loadSkills() {
  state.skillsAll = await window.api.skills.list();
  if (state.currentProjectId) {
    const enabled = await window.api.skills.enabledForProject(state.currentProjectId);
    state.skillsEnabledIds = new Set(enabled.map((s) => s.id));
    state.skills = enabled;
  } else { state.skillsEnabledIds = new Set(); state.skills = []; }
  renderScope();
  if (state.page === 'skills') renderSkillList();
}
function showSkills() {
  state.page = 'skills';
  // Say WHICH project the toggles govern — the page edits the sidebar's
  // selected project, and that was invisible.
  const proj = state.projects.find((p) => p.id === state.currentProjectId);
  const badge = document.getElementById('skills-proj-name');
  if (badge) badge.textContent = proj ? proj.name.toUpperCase() : 'no project selected';
  el.pages.querySelectorAll('.page').forEach((s) => { s.hidden = s.dataset.page !== 'skills'; });
  el.tabbar.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.page === 'skills'));
  el.tbSlug.textContent = '/ skills';
  el.skillsMsg.textContent = '';
  buildSkillsSource();
  renderSkillList(); closeSkillEditor();
}

// MCP servers that can supply skills (expose a skills_update tool).
function skillSourceServers() {
  return state.mcpServers.filter((s) => s.enabled && (s.tools || []).some((t) => /skills_update/i.test(t.name)));
}
function buildSkillsSource() {
  const servers = skillSourceServers();
  if (!servers.some((s) => s.id === state.skillsSource)) state.skillsSource = servers[0] ? servers[0].id : null;
  const cur = servers.find((s) => s.id === state.skillsSource);
  el.skillsSrcLabel.textContent = cur ? cur.name : (servers.length ? 'select source…' : 'no skill servers');
  el.skillsSrcMenu.innerHTML = '';
  for (const s of servers) {
    const b = document.createElement('button'); b.className = 'dropdown__item'; b.type = 'button';
    b.innerHTML = `<span class="tick">${s.id === state.skillsSource ? '›' : ''}</span>${escapeHtml(s.name)}`;
    b.onclick = () => { state.skillsSource = s.id; el.skillsSrcMenu.hidden = true; buildSkillsSource(); };
    el.skillsSrcMenu.appendChild(b);
  }
}
function renderSkillList() {
  el.skillList.innerHTML = '';
  el.skillEmpty.hidden = state.skillsAll.length > 0;
  for (const s of state.skillsAll) {
    const on = state.skillsEnabledIds.has(s.id);
    const toolsLabel = s.tools && s.tools.length ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'} scoped` : 'unscoped (all tools)';
    const li = document.createElement('li'); li.className = 'conn';
    li.innerHTML = `
      <span class="conn__status${on ? ' conn__status--ok' : ''}"></span>
      <div class="conn__info"><div class="conn__label">${escapeHtml(s.name)}</div><div class="conn__type">skill</div></div>
      <div class="conn__mid"><div class="conn__url">${escapeHtml(s.description || '')}</div><div class="conn__meta">${escapeHtml(toolsLabel)}</div></div>
      <div class="conn__actions"></div>`;
    const actions = li.querySelector('.conn__actions');
    const toggle = document.createElement('button'); toggle.className = 'toggle' + (on ? ' is-on' : ''); toggle.innerHTML = '<div class="toggle__knob"></div>';
    toggle.title = state.currentProjectId ? (on ? 'Enabled for this project' : 'Enable for this project') : 'Select a project first';
    toggle.onclick = async () => {
      if (!state.currentProjectId) { el.skillsMsg.textContent = 'Select a project first to enable skills.'; el.skillsMsg.className = 'test-result test-result--error'; return; }
      await window.api.skills.setForProject({ projectId: state.currentProjectId, skillId: s.id, enabled: !on });
      await loadSkills(); renderSkillList();
    };
    actions.appendChild(toggle);
    const edit = document.createElement('button'); edit.className = 'conn__btn'; edit.textContent = 'EDIT'; edit.onclick = () => openSkillEditor(s.id); actions.appendChild(edit);
    const rm = document.createElement('button'); rm.className = 'conn__btn conn__btn--danger'; rm.textContent = 'REMOVE'; rm.onclick = async () => { await window.api.skills.remove(s.id); await loadSkills(); renderSkillList(); }; actions.appendChild(rm);
    el.skillList.appendChild(li);
  }
}
function openSkillEditor(id) {
  state.skillEditing = id ?? null;
  if (id) { const s = state.skillsAll.find((x) => x.id === id); el.skillEditorTitle.textContent = 'EDIT SKILL'; el.sName.value = s.name || ''; el.sDesc.value = s.description || ''; el.sDef.value = s.definition || ''; el.sTools.value = s.tools ? s.tools.join(', ') : ''; }
  else { el.skillEditorTitle.textContent = 'NEW SKILL'; el.sName.value = ''; el.sDesc.value = ''; el.sDef.value = ''; el.sTools.value = ''; }
  el.skillEditor.hidden = false;
}
function closeSkillEditor() { el.skillEditor.hidden = true; state.skillEditing = null; }

// ── Agents screen (authored per-project sub-agents) ────────────────
async function loadAgents() {
  if (state.currentProjectId) state.agents = await window.api.agents.list(state.currentProjectId);
  else state.agents = [];
  if (state.page === 'agents') renderAgentList();
}
function showAgents() {
  state.page = 'agents';
  el.pages.querySelectorAll('.page').forEach((s) => { s.hidden = s.dataset.page !== 'agents'; });
  el.tabbar.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.page === 'agents'));
  el.tbSlug.textContent = '/ agents';
  el.agentsMsg.textContent = '';
  renderAgentList(); closeAgentEditor();
}
function renderAgentList() {
  el.agentList.innerHTML = '';
  el.agentEmpty.hidden = state.agents.length > 0;
  for (const a of state.agents) {
    const li = document.createElement('li'); li.className = 'conn';
    const toolsLabel = a.tools && a.tools.length ? `${a.tools.length} tool${a.tools.length === 1 ? '' : 's'}` : 'all tools';
    li.innerHTML = `
      <span class="conn__status conn__status--ok"></span>
      <div class="conn__info"><div class="conn__label">${escapeHtml(a.name)}</div><div class="conn__type">agent</div></div>
      <div class="conn__mid"><div class="conn__url">${escapeHtml(a.description || '')}</div><div class="conn__meta">${escapeHtml(a.model || 'chat model')} · ${toolsLabel}</div></div>
      <div class="conn__actions"></div>`;
    const actions = li.querySelector('.conn__actions');
    const edit = document.createElement('button'); edit.className = 'conn__btn'; edit.textContent = 'EDIT'; edit.onclick = () => openAgentEditor(a.id); actions.appendChild(edit);
    const rm = document.createElement('button'); rm.className = 'conn__btn conn__btn--danger'; rm.textContent = 'REMOVE'; rm.onclick = async () => { await window.api.agents.remove(a.id); await loadAgents(); renderAgentList(); }; actions.appendChild(rm);
    el.agentList.appendChild(li);
  }
}
function openAgentEditor(id) {
  state.agentEditing = id ?? null;
  const a = id ? state.agents.find((x) => x.id === id) : null;
  el.agentEditorTitle.textContent = id ? 'EDIT AGENT' : 'NEW AGENT';
  el.aName.value = a ? (a.name || '') : '';
  el.aDesc.value = a ? (a.description || '') : '';
  el.aPrompt.value = a ? (a.system_prompt || '') : '';
  el.aModel.value = a ? (a.model || '') : '';
  el.aTools.value = a && a.tools ? a.tools.join(', ') : '';
  el.agentEditor.hidden = false;
}
function closeAgentEditor() { el.agentEditor.hidden = true; state.agentEditing = null; }
async function saveAgent() {
  if (!state.currentProjectId) { el.agentsMsg.textContent = 'Select a project first.'; el.agentsMsg.className = 'test-result test-result--error'; return; }
  const name = el.aName.value.trim();
  if (!name) { el.agentsMsg.textContent = 'enter a name'; el.agentsMsg.className = 'test-result test-result--error'; return; }
  const tools = el.aTools.value.split(',').map((t) => t.trim()).filter(Boolean);
  const patch = {
    name,
    description: el.aDesc.value.trim() || null,
    systemPrompt: el.aPrompt.value.trim() || null,
    model: el.aModel.value.trim() || null,
    tools: tools.length ? tools : null
  };
  if (state.agentEditing) await window.api.agents.update(state.agentEditing, patch);
  else await window.api.agents.create({ projectId: state.currentProjectId, ...patch });
  closeAgentEditor(); await loadAgents(); renderAgentList();
}
async function saveSkill() {
  const name = el.sName.value.trim();
  if (!name) { el.skillsMsg.textContent = 'enter a name'; el.skillsMsg.className = 'test-result test-result--error'; return; }
  const tools = el.sTools.value.split(',').map((t) => t.trim()).filter(Boolean);
  const patch = { name, description: el.sDesc.value.trim() || null, definition: el.sDef.value.trim() || null, tools: tools.length ? tools : null };
  if (state.skillEditing) await window.api.skills.update(state.skillEditing, patch);
  else await window.api.skills.create(patch);
  closeSkillEditor(); await loadSkills(); renderSkillList();
}
async function importSkills() {
  if (!state.skillsSource) { el.skillsMsg.textContent = 'Pick an import source (an MCP server with skills). Sign in to one first.'; el.skillsMsg.className = 'test-result test-result--error'; return; }
  el.skillsMsg.textContent = 'connecting…'; el.skillsMsg.className = 'test-result';
  const unsub = window.api.onSkillsProgress((p) => {
    if (p.phase === 'list') el.skillsMsg.textContent = 'fetching skill list…';
    else if (p.phase === 'list-done') el.skillsMsg.textContent = `found ${p.total} skills — installing…`;
    else if (p.phase === 'install') el.skillsMsg.textContent = `installing ${p.name} (${p.done + 1}/${p.total})…`;
    else if (p.phase === 'bulk') el.skillsMsg.textContent = 'downloading skill bundle…';
    else if (p.phase === 'error') el.skillsMsg.textContent = `error on ${p.name}: ${p.error}`;
  });
  try {
    const r = await window.api.skills.importFromMcp(state.skillsSource);
    if (r.ok) { el.skillsMsg.textContent = `imported ${r.count} skills: ${r.names.slice(0, 6).join(', ')}${r.names.length > 6 ? '…' : ''}`; el.skillsMsg.className = 'test-result test-result--ok'; await loadSkills(); renderSkillList(); }
    else { el.skillsMsg.textContent = r.error || 'import failed'; el.skillsMsg.className = 'test-result test-result--error'; }
  } catch (e) { el.skillsMsg.textContent = 'error: ' + (e?.message || 'failed'); el.skillsMsg.className = 'test-result test-result--error'; }
  finally { unsub(); }
}

// ── Token help (always scoped to ONE provider — the one in context) ─
function currentHelpType() {
  if (!el.connEditor.hidden) return state.editorType;               // editing a connection
  if (state.selected?.providerId) {                                 // the selected model's provider
    const p = state.providers.find((x) => x.id === state.selected.providerId);
    if (p) return p.type;
  }
  if (state.providers[0]) return state.providers[0].type;           // first configured
  return state.registry[0]?.type;                                   // last resort
}

function openHelp(type) {
  const r = providerDef(type || currentHelpType());
  if (!r) return;
  el.helpTitle.textContent = `GET AN API KEY · ${r.label.toUpperCase()}`;
  const steps = (r.help || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  el.helpBody.innerHTML = `
    <div class="help-provider">
      <div class="help-provider__head">
        <span class="help-provider__name">${escapeHtml(r.label)}</span>
        <button class="conn__btn help-provider__open" type="button">OPEN CONSOLE ↗</button>
      </div>
      <ol class="help-steps">${steps}</ol>
      <div class="field__hint">Base URL <code>${escapeHtml(r.baseUrl)}</code> · key format <code>${escapeHtml(r.keyHint)}</code></div>
    </div>`;
  el.helpBody.querySelector('.help-provider__open').onclick = () => window.api.openExternal(r.docs);
  el.help.hidden = false;
}
function closeHelp() { el.help.hidden = true; }

// ── Command palette ───────────────────────────────────────────────
function openPalette() { el.palette.hidden = false; el.paletteInput.value = ''; renderPalette(''); el.paletteInput.focus(); }
function closePalette() { el.palette.hidden = true; }
function renderPalette(query) {
  const q = query.toLowerCase();
  const pages = [{ label: 'Chat', page: 'chat' }, { label: 'Overview', page: 'overview' }, { label: 'Documents', page: 'documents' }]
    .filter((p) => p.label.toLowerCase().includes(q));
  const projects = state.projects.filter((p) => p.name.toLowerCase().includes(q));
  el.paletteList.innerHTML = '';
  const section = (label) => { const d = document.createElement('div'); d.className = 'palette__group'; d.textContent = label; el.paletteList.appendChild(d); };
  const item = (label, meta, onClick) => { const d = document.createElement('div'); d.className = 'palette__item'; d.innerHTML = `<span>${escapeHtml(label)}</span>` + (meta ? `<span class="meta">${escapeHtml(meta)}</span>` : ''); d.onclick = onClick; el.paletteList.appendChild(d); };
  if (state.currentProjectId && pages.length) { section('PAGES'); pages.forEach((p) => item(p.label, '', () => { closePalette(); showPage(p.page); })); }
  if (projects.length) { section('PROJECTS'); projects.forEach((p) => item(p.name, '', () => { closePalette(); selectProject(p.id); })); }
  section('ACTIONS');
  item('Model connections…', '', () => { closePalette(); showModels(); });
  item('MCP servers…', '', () => { closePalette(); showMcp(); });
  item('Skills…', '', () => { closePalette(); showSkills(); });
  item('New project…', '⌘N', () => { closePalette(); openNewProjectForm(); });
  item(state.theme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance', '', () => { closePalette(); toggleTheme(); });
}
function openNewProjectForm() { el.newProjectForm.hidden = false; el.newProjectInput.focus(); }

// ── Events ────────────────────────────────────────────────────────
el.themeBtn.onclick = toggleTheme;
el.modelsBtn.onclick = showModels;
el.mcpBtn.onclick = showMcp;
el.mcpAdd.onclick = () => openMcpEditor(null);
el.mcpDone.onclick = leaveMcp;
el.mcpCancel.onclick = closeMcpEditor;
el.mcpConnect.onclick = connectMcp;
el.mcpSave.onclick = saveMcp;
el.mTransportBtn.onclick = (e) => { e.stopPropagation(); toggleTransportMenu(); };
el.scopeMcpAdd.onclick = showMcp;
el.scopeSkillsManage.onclick = showSkills;
el.skillsImport.onclick = importSkills;
el.skillsSrcBtn.onclick = (e) => { e.stopPropagation(); el.skillsSrcMenu.hidden = !el.skillsSrcMenu.hidden; };
el.skillAdd.onclick = () => openSkillEditor(null);
el.skillCancel.onclick = closeSkillEditor;
el.skillSave.onclick = saveSkill;
el.modelBtn.onclick = (e) => { e.stopPropagation(); toggleModelMenu(); };
el.modelSwitch.onclick = () => {
  const proj = state.projects.find((p) => p.id === state.currentProjectId);
  const pref = proj && proj.preferred_model;
  if (!pref) return;
  const r = resolveProvider(pref);
  if (r.providerId) selectModel(r.providerId, pref);
};
el.ovPrefBtn.onclick = (e) => { e.stopPropagation(); const show = el.ovPrefMenu.hidden; if (show) buildPrefMenu(); el.ovPrefMenu.hidden = !show; };
el.ovFastBtn.onclick = (e) => { e.stopPropagation(); if (el.ovFastBtn.disabled) return; const show = el.ovFastMenu.hidden; if (show) buildFastMenu(); el.ovFastMenu.hidden = !show; };
el.ctxMeter.onclick = () => showPage('internals');
el.intLenstabs.querySelectorAll('.lenstab').forEach((b) => {
  b.onclick = () => { state.internalsLens = b.dataset.lens; renderInternals(); };
});
el.intEvalBtn.onclick = (e) => { e.stopPropagation(); const show = el.intEvalMenu.hidden; if (show) buildEvalMenu(); el.intEvalMenu.hidden = !show; };
el.intEvalRun.onclick = () => runEvaluate();
document.addEventListener('click', (e) => {
  if (!el.model.contains(e.target)) toggleModelMenu(false);
  if (!el.typeDd.contains(e.target)) toggleTypeMenu(false);
  if (!el.modelDd.contains(e.target)) closeModelSuggest();
  if (!el.fastModelDd.contains(e.target)) closeFastModelSuggest();
  if (!el.mTransportDd.contains(e.target)) toggleTransportMenu(false);
  if (el.skillsSrcDd && !el.skillsSrcDd.contains(e.target)) el.skillsSrcMenu.hidden = true;
  if (el.ovPrefDd && !el.ovPrefDd.contains(e.target)) el.ovPrefMenu.hidden = true;
  if (el.ovFastDd && !el.ovFastDd.contains(e.target)) el.ovFastMenu.hidden = true;
  if (el.intEvalDd && !el.intEvalDd.contains(e.target)) el.intEvalMenu.hidden = true;
});

el.tabbar.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.page === 'skills') return showSkills();
    if (b.dataset.page === 'agents') return showAgents();
    showPage(b.dataset.page);
  };
});
el.agentAdd.onclick = () => openAgentEditor(null);
el.agentSave.onclick = saveAgent;
el.agentCancel.onclick = closeAgentEditor;
el.railTabs.querySelectorAll('.rail__tab').forEach((b) => { b.onclick = () => showRail(b.dataset.rail); });
el.ovCheatSave.onclick = saveCheatSheet;
document.getElementById('ov-env-save').onclick = saveBuildEnv;

el.newProjectBtn.onclick = () => { el.newProjectForm.hidden = !el.newProjectForm.hidden; if (!el.newProjectForm.hidden) el.newProjectInput.focus(); };
el.heroNewProject.onclick = openNewProjectForm;
el.newProjectForm.onsubmit = (e) => { e.preventDefault(); const name = el.newProjectInput.value.trim(); if (!name) return; el.newProjectInput.value = ''; el.newProjectForm.hidden = true; createProject(name); };
el.newChatBtn.onclick = createChat;
el.ovWdChange.onclick = async () => {
  if (!state.currentProjectId) return;
  const r = await window.api.projects.pickWorkingDir(state.currentProjectId);
  if (r && r.ok) { const i = state.projects.findIndex((p) => p.id === state.currentProjectId); if (i >= 0) state.projects[i] = r.project; renderOverview(); }
};
el.ovWdReveal.onclick = () => { const p = state.projects.find((x) => x.id === state.currentProjectId); if (p && p.working_dir) window.api.projects.revealPath(p.working_dir); };
el.ovOutChange.onclick = async () => {
  if (!state.currentProjectId) return;
  const r = await window.api.projects.pickOutputDir(state.currentProjectId);
  if (r && r.ok) { const i = state.projects.findIndex((p) => p.id === state.currentProjectId); if (i >= 0) state.projects[i] = r.project; updateOutputDir(r.project); }
};
el.ovOutReveal.onclick = async () => {
  const p = state.projects.find((x) => x.id === state.currentProjectId);
  if (!p) return;
  const eff = await window.api.projects.effectiveOutputDir(p.id);
  if (eff && eff.outputDir) window.api.projects.revealPath(eff.outputDir);
};
el.railAddDoc.onclick = () => { const t = el.input.value.trim() || 'Untitled'; createDocument(t); el.input.value = ''; autosize(); };

el.send.onclick = () => {
  if (el.send.dataset.mode === 'stop') {
    window.api.abortChat();
    el.send.disabled = true;            // one stop is enough; finally() re-arms it
    el.send.textContent = 'STOPPING…';
    return;
  }
  submit();
};
el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
el.input.addEventListener('input', autosize);

// Attachments: button/picker + drag-and-drop onto the chat.
el.attachBtn.onclick = () => el.attachInput.click();
el.attachDirBtn.onclick = () => el.attachDirInput.click();
el.attachDirInput.onchange = () => { readDirAttachments(el.attachDirInput.files); el.attachDirInput.value = ''; };
el.attachInput.onchange = () => { readAttachments(el.attachInput.files); el.attachInput.value = ''; };
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
el.messages.addEventListener('dragover', (e) => { e.preventDefault(); el.messages.classList.add('dropping'); });
el.messages.addEventListener('dragleave', (e) => { if (e.target === el.messages) el.messages.classList.remove('dropping'); });
el.messages.addEventListener('drop', (e) => { e.preventDefault(); el.messages.classList.remove('dropping'); if (state.currentChatId) readAttachments(e.dataTransfer.files); });

// Models screen events
el.connAdd.onclick = () => openEditor(null);
el.modelsDone.onclick = leaveModels;
el.connCancel.onclick = closeEditor;
el.connTest.onclick = testEditor;
el.connSave.onclick = saveEditor;
el.typeBtn.onclick = (e) => { e.stopPropagation(); toggleTypeMenu(); };
el.fModel.addEventListener('focus', openModelSuggest);
el.fModel.addEventListener('click', openModelSuggest);
el.fModel.addEventListener('input', () => { buildModelSuggest(); if (el.fModelMenu.children.length) el.fModelMenu.hidden = false; });
el.fFastModel.addEventListener('focus', openFastModelSuggest);
el.fFastModel.addEventListener('click', openFastModelSuggest);
el.fFastModel.addEventListener('input', () => { buildFastModelSuggest(); if (el.fFastModelMenu.children.length) el.fFastModelMenu.hidden = false; });
el.modelsHelp.onclick = () => openHelp();
el.keyHelp.onclick = () => openHelp(state.editorType);
el.helpClose.onclick = closeHelp;
el.help.addEventListener('click', (e) => { if (e.target === el.help) closeHelp(); });

el.paletteBtn.onclick = openPalette;
el.paletteInput.addEventListener('input', () => renderPalette(el.paletteInput.value));
el.palette.addEventListener('click', (e) => { if (e.target === el.palette) closePalette(); });

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === 'k') { e.preventDefault(); el.palette.hidden ? openPalette() : closePalette(); }
  if ((e.metaKey || e.ctrlKey) && k === 'n') { e.preventDefault(); openNewProjectForm(); }
  if (e.key === 'Escape') { closePalette(); closeHelp(); toggleModelMenu(false); toggleTypeMenu(false); closeModelSuggest(); toggleTransportMenu(false); if (av.panel && !av.panel.hidden) closeArtifact(); }
});

// ── Boot ──────────────────────────────────────────────────────────
(async function init() {
  applyTheme();
  await loadProviders();
  await loadMcp();
  await loadSkills();
  await loadProjects();
  if (state.projects.length > 0) selectProject(state.projects[0].id);
  else showFirstRun();
  console.log(`[boot] init done providers=${state.providers.length} projects=${state.projects.length} selected=${JSON.stringify(state.selected)}`);
  // Deferred version-drift check (badges the MCP button when a server has
  // newer skills/tools than the app imported) — after boot so it never
  // delays first paint; connection failures are tolerated silently.
  setTimeout(() => { checkMcpSync(); }, 8000);
  // App-update check: badge the titlebar when origin has new commits; the
  // chip is the button — click pulls, refreshes deps, and restarts. Re-check
  // every 4 hours; failures stay silent (offline is not an error state).
  const checkAppUpdate = async () => {
    try {
      const r = await window.api.update.check();
      const chip = document.getElementById('update-chip');
      if (r && r.available) {
        chip.hidden = false;
        chip.textContent = `⟳ UPDATE (${r.behind})`;
        chip.title = `Shamrock update available — ${r.behind} commit${r.behind === 1 ? '' : 's'} behind.\nLatest: ${r.latest || ''}\nClick to update and restart.`;
      } else chip.hidden = true;
    } catch {}
  };
  setTimeout(checkAppUpdate, 12000);
  setInterval(checkAppUpdate, 4 * 60 * 60 * 1000);
  document.getElementById('update-chip').onclick = async (e) => {
    const chip = e.target;
    if (chip.dataset.armed !== '1') {
      chip.dataset.armed = '1';
      chip.textContent = '⟳ UPDATE & RESTART?';
      setTimeout(() => { if (chip.dataset.armed === '1') { chip.dataset.armed = ''; checkAppUpdate(); } }, 6000);
      return;
    }
    chip.dataset.armed = '';
    chip.textContent = 'UPDATING…';
    const off = window.api.update.onPhase(({ phase }) => {
      chip.textContent = phase === 'pull' ? 'PULLING…' : phase === 'deps' ? 'DEPENDENCIES…' : 'RESTARTING…';
    });
    const r = await window.api.update.apply();   // success restarts the app
    off();
    if (r && !r.ok) { chip.textContent = '⟳ UPDATE FAILED'; chip.title = r.error || 'update failed'; setTimeout(checkAppUpdate, 5000); }
  };
})();
