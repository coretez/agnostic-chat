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
  themeBtn: $('theme-btn'), paletteBtn: $('palette-btn'), modelsBtn: $('models-btn'),
  projectList: $('project-list'), chatList: $('chat-list'),
  newProjectBtn: $('new-project-btn'), newProjectForm: $('new-project-form'), newProjectInput: $('new-project-input'),
  ovName: $('ov-name'), ovWdPath: $('ov-wd-path'), ovWdChange: $('ov-wd-change'), ovWdReveal: $('ov-wd-reveal'),
  ovModel: $('ov-model'), ovChats: $('ov-chats'), ovDocs: $('ov-docs'), ovSkills: $('ov-skills'), ovMcp: $('ov-mcp'),
  heroNewProject: $('hero-new-project'), newChatBtn: $('new-chat-btn'),
  tabbar: $('tabbar'), toolbarNote: $('toolbar-note'), pages: $('pages'),
  messages: $('messages'), input: $('input'), send: $('send'), composerScope: $('composer-scope'),
  attachBtn: $('attach-btn'), attachInput: $('attach-input'), composerAttach: $('composer-attach'),
  railTabs: $('rail-tabs'), railDocList: $('rail-doc-list'), railAddDoc: $('rail-add-doc'),
  scopeSkillsHead: $('scope-skills-head'), scopeSkillsNote: $('scope-skills-note'),
  palette: $('palette'), paletteInput: $('palette-input'), paletteList: $('palette-list'),
  // Models screen
  connList: $('conn-list'), connEmpty: $('conn-empty'), connEditor: $('conn-editor'), editorTitle: $('editor-title'),
  typeDd: $('type-dd'), typeBtn: $('type-btn'), typeLabel: $('type-label'), typeMenu: $('type-menu'),
  fLabel: $('f-label'), fBaseurl: $('f-baseurl'), fSecret: $('f-secret'), fSecretHint: $('f-secret-hint'),
  modelDd: $('model-dd'), fModel: $('f-model'), fModelMenu: $('f-model-menu'), fFastModel: $('f-fast-model'),
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
  sName: $('s-name'), sDesc: $('s-desc'), sDef: $('s-def'),
  skillCancel: $('skill-cancel'), skillSave: $('skill-save')
};

const state = {
  theme: 'light',
  selected: null,           // { providerId, model }
  page: 'chat',
  projects: [], currentProjectId: null,
  chats: [], currentChatId: null,
  documents: [], skills: [], attachments: [],
  registry: [], providers: [], showAllModels: false,
  skillsAll: [], skillsEnabledIds: new Set(), skillEditing: null, skillsSource: null,
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
}
function showFirstRun() {
  el.tabbar.hidden = true;
  el.pages.querySelectorAll('.page').forEach((s) => { s.hidden = s.dataset.page !== 'firstrun'; });
  el.tbSlug.textContent = '';
}
function showRail(name) {
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
  el.ovPrefLabel.textContent = p.preferred_model || 'None';
  el.ovModel.textContent = state.selected?.model || '—';
  el.ovChats.textContent = state.chats.length;
  el.ovDocs.textContent = state.documents.length;
  el.ovSkills.textContent = state.skills.length;
  el.ovMcp.textContent = state.mcpServers.filter((s) => s.enabled).length;
  updateModelSwitch();
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
function renderScope() {
  const n = state.skills.length;
  el.scopeSkillsHead.textContent = `SKILLS · ${n} ENABLED`;
  el.scopeSkillsNote.textContent = n === 0 ? 'No skills enabled for this project yet.' : state.skills.map((s) => s.name).join(', ');

  const servers = state.mcpServers.filter((s) => s.enabled);
  el.scopeMcpHead.textContent = `MCP SERVERS · ${servers.length}`;
  el.scopeMcpList.innerHTML = '';
  el.scopeMcpNote.hidden = servers.length > 0;
  for (const s of servers) {
    const li = document.createElement('li');
    li.className = 'raillist__item';
    li.innerHTML = `<div class="title">${escapeHtml(s.name)}</div><div class="sub">${escapeHtml(s.transport)} · ${(s.tools || []).length} tools · ${escapeHtml(s.status || 'untested')}</div>`;
    li.onclick = () => showMcp();
    el.scopeMcpList.appendChild(li);
  }
}
function updateComposerMeta() {
  const model = state.selected?.model;
  el.composerScope.textContent = `${state.documents.length} DOCS · ${state.skills.length} SKILLS · ${modelTag(model)}`;
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
    if (role === 'assistant') renderAssistantBody(bodyEl, text || '');
    else bodyEl.textContent = text;
  }
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
  return div;
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
    if (m.role !== 'user' && meta && meta.tools) toolChips(t, meta.tools);
  }
}

// ── Data flow ─────────────────────────────────────────────────────
async function loadProviders() {
  state.registry = await window.api.providers.registry();
  state.providers = await window.api.providers.list();
  if (!state.selected) state.selected = await initialSelection();
  if (state.selected) el.modelLabel.textContent = state.selected.model;
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
  state.documents = await window.api.documents.list(id);
  await loadSkills();
  renderChats(); renderDocs();
  showPage('chat');
  updateModelSwitch();

  if (state.chats.length > 0) selectChat(state.chats[0].id);
  else { el.messages.innerHTML = ''; turn('NO CHATS YET · HIT + NEXT TO CHATS', 'meta'); el.send.disabled = true; }
}

async function selectChat(id) {
  state.currentChatId = id;
  el.send.disabled = false;
  const chat = state.chats.find((c) => c.id === id);
  if (chat?.model) { state.selected = resolveProvider(chat.model); el.modelLabel.textContent = chat.model; updateComposerMeta(); }
  updateModelSwitch();
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

async function submit() {
  const text = el.input.value.trim();
  if ((!text && !state.attachments.length) || !state.currentChatId) return;
  const attached = state.attachments.slice();
  state.attachments = []; renderAttachChips();
  const userTurn = turn(text || '📎 (attached files)', 'user');
  if (attached.length) attachChipsOnTurn(userTurn, attached);
  el.input.value = ''; autosize(); el.send.disabled = true;
  document.documentElement.classList.add('busy');
  await window.api.messages.add({ chatId: state.currentChatId, role: 'user', content: text });
  // Keep attachments as project documents so they persist + appear in the rail.
  if (attached.length && state.currentProjectId) {
    for (const a of attached) { try { await window.api.documents.create({ projectId: state.currentProjectId, title: a.name, content: a.content, mimeType: 'text', source: 'upload' }); } catch {} }
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
  const nearBottom = () => el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
  const unsub = window.api.onChatProgress((ev) => {
    if (ev.type === 'token') {
      streamed += ev.text;
      const stick = nearBottom();
      streamRender(body, streamed); // prose live; html/svg buffered as placeholders
      if (stick) el.messages.scrollTop = el.messages.scrollHeight;
    } else if (ev.type === 'model') { if (!streamed) status.textContent = 'thinking…'; }
    else if (ev.type === 'tool-start') { if (!streamed) status.textContent = `running ${shortTool(ev.name)}…`; }
    planEvent(ev);
  });

  try {
    const history = (await window.api.messages.list(state.currentChatId)).map((m) => ({ role: m.role, content: m.content }));
    if (attached.length && history.length) {
      const block = attached.map((a) => `\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.content}\n\`\`\``).join('');
      const last = history[history.length - 1];
      history[history.length - 1] = { ...last, content: (last.content || '') + block };
    }
    const res = await window.api.sendMessage({ providerId: state.selected?.providerId, model, messages: history, text, projectId: state.currentProjectId });
    if (res.compressed) {
      const note = document.createElement('div');
      note.className = 'turn turn--meta';
      note.innerHTML = '<div class="turn__body">⚡ EARLIER HISTORY COMPRESSED TO SAVE CONTEXT</div>';
      el.messages.insertBefore(note, thinking);
    }
    clearTimeout(_streamPending);
    const finalText = (streamed || res.reply || '(empty response)').trim();
    renderAssistantBody(body, finalText);
    if (res.toolTrace && res.toolTrace.length) toolChips(thinking, res.toolTrace);
    el.messages.scrollTop = el.messages.scrollHeight;
    await window.api.messages.add({ chatId: state.currentChatId, role: 'assistant', content: finalText, metadata: { model: res.model, tools: res.toolTrace || [] } });
  } catch (err) {
    thinking.className = 'turn turn--meta';
    thinking.innerHTML = `<div class="turn__body">ERROR · ${escapeHtml(err?.message ?? 'request failed')}</div>`;
  } finally { unsub(); planStop(); el.send.disabled = false; document.documentElement.classList.remove('busy'); el.input.focus(); }
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
}
function leaveMcp() { if (state.currentProjectId) showPage('chat'); else showFirstRun(); }

async function loadMcp() { state.mcpServers = await window.api.mcp.list(); renderScope(); }
async function refreshMcp() { state.mcpServers = await window.api.mcp.list(); renderMcpList(); renderScope(); }

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
    li.innerHTML = `
      <span class="conn__status${statusCls}" title="${escapeHtml(s.status_detail || s.status || 'untested')}"></span>
      <div class="conn__info"><div class="conn__label">${escapeHtml(s.name)}</div><div class="conn__type">${escapeHtml(s.transport)}${s.tools && s.tools.length ? ' · ' + s.tools.length + ' tools' : ''}</div></div>
      <div class="conn__mid"><div class="conn__url">${escapeHtml(detail)}</div><div class="conn__model${s.status === 'error' ? ' conn__model--err' : ''}">${escapeHtml(subText)}</div></div>
      <div class="conn__actions"></div>`;
    const actions = li.querySelector('.conn__actions');

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
    const li = document.createElement('li'); li.className = 'conn';
    li.innerHTML = `
      <span class="conn__status${on ? ' conn__status--ok' : ''}"></span>
      <div class="conn__info"><div class="conn__label">${escapeHtml(s.name)}</div><div class="conn__type">skill</div></div>
      <div class="conn__mid"><div class="conn__url">${escapeHtml(s.description || '')}</div></div>
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
  if (id) { const s = state.skillsAll.find((x) => x.id === id); el.skillEditorTitle.textContent = 'EDIT SKILL'; el.sName.value = s.name || ''; el.sDesc.value = s.description || ''; el.sDef.value = s.definition || ''; }
  else { el.skillEditorTitle.textContent = 'NEW SKILL'; el.sName.value = ''; el.sDesc.value = ''; el.sDef.value = ''; }
  el.skillEditor.hidden = false;
}
function closeSkillEditor() { el.skillEditor.hidden = true; state.skillEditing = null; }
async function saveSkill() {
  const name = el.sName.value.trim();
  if (!name) { el.skillsMsg.textContent = 'enter a name'; el.skillsMsg.className = 'test-result test-result--error'; return; }
  const patch = { name, description: el.sDesc.value.trim() || null, definition: el.sDef.value.trim() || null };
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
document.addEventListener('click', (e) => {
  if (!el.model.contains(e.target)) toggleModelMenu(false);
  if (!el.typeDd.contains(e.target)) toggleTypeMenu(false);
  if (!el.modelDd.contains(e.target)) closeModelSuggest();
  if (!el.mTransportDd.contains(e.target)) toggleTransportMenu(false);
  if (el.skillsSrcDd && !el.skillsSrcDd.contains(e.target)) el.skillsSrcMenu.hidden = true;
  if (el.ovPrefDd && !el.ovPrefDd.contains(e.target)) el.ovPrefMenu.hidden = true;
});

el.tabbar.querySelectorAll('.tab').forEach((b) => { b.onclick = () => (b.dataset.page === 'skills' ? showSkills() : showPage(b.dataset.page)); });
el.railTabs.querySelectorAll('.rail__tab').forEach((b) => { b.onclick = () => showRail(b.dataset.rail); });

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
el.railAddDoc.onclick = () => { const t = el.input.value.trim() || 'Untitled'; createDocument(t); el.input.value = ''; autosize(); };

el.send.onclick = submit;
el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
el.input.addEventListener('input', autosize);

// Attachments: button/picker + drag-and-drop onto the chat.
el.attachBtn.onclick = () => el.attachInput.click();
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
})();
