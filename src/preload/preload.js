'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The ONLY surface exposed to the renderer (window.api).
 *
 * We deliberately expose a small, typed set of functions rather than the raw
 * ipcRenderer. The chat UI cannot invoke arbitrary IPC channels or reach Node —
 * it can only call exactly what we hand it here. This is the seam where all
 * future capabilities (LLM calls, browser control, tool execution) get gated.
 */
contextBridge.exposeInMainWorld('api', {
  /**
   * Send a chat message to the main process.
   * @param {{ text: string, model?: string }} payload
   * @returns {Promise<{ model: string, reply: string, receivedAt: string }>}
   */
  sendMessage: (payload) => ipcRenderer.invoke('chat:send', payload),

  /** Answer a mid-turn "tool-call limit reached" prompt: more>0 grants that many
   *  more tool iterations; 0 stops and forces a final wrap-up. */
  continueChat: (more, turnId) => ipcRenderer.send('chat:continue', { more, turnId }),
  abortChat: (turnId) => ipcRenderer.send('chat:abort', { turnId }),

  /** Open an https link in the user's default browser. */
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  /** Subscribe to live chat progress events; returns an unsubscribe fn. */
  onChatProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat:progress', h);
    return () => ipcRenderer.removeListener('chat:progress', h);
  },

  /** Subscribe to live skill-import progress; returns an unsubscribe fn. */
  onSkillsProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('skills:progress', h);
    return () => ipcRenderer.removeListener('skills:progress', h);
  },

  /** Librarian (O31): filing events + tag vocabulary + batch tidy. */
  onLibrarianUpdate: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('librarian:update', h);
    return () => ipcRenderer.removeListener('librarian:update', h);
  },
  library: {
    tags: (projectId) => ipcRenderer.invoke('library:tags', { projectId }),
    tidy: (input) => ipcRenderer.invoke('library:tidy', input),
    untagDocument: (documentId, tagId) => ipcRenderer.invoke('library:untagDocument', { documentId, tagId }),
    untagChat: (chatId, tagId) => ipcRenderer.invoke('library:untagChat', { chatId, tagId })
  },

  update: {
    check: () => ipcRenderer.invoke('update:check'),
    apply: () => ipcRenderer.invoke('update:apply'),
    onPhase: (h) => { const f = (_e, p) => h(p); ipcRenderer.on('update:phase', f); return () => ipcRenderer.removeListener('update:phase', f); }
  },

  projects: {
    list: (opts) => ipcRenderer.invoke('projects:list', opts),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    rename: (id, name) => ipcRenderer.invoke('projects:rename', { id, name }),
    archive: (id) => ipcRenderer.invoke('projects:archive', { id }),
    pickWorkingDir: (id) => ipcRenderer.invoke('projects:pickWorkingDir', { id }),
    revealPath: (p) => ipcRenderer.invoke('app:revealPath', p),
    setPreferredModel: (id, model) => ipcRenderer.invoke('projects:setPreferredModel', { id, model }),
    gitStatus: (id) => ipcRenderer.invoke('projects:gitStatus', { id }),
    gitInit: (id) => ipcRenderer.invoke('projects:gitInit', { id }),
    setCheatSheet: (id, text) => ipcRenderer.invoke('projects:setCheatSheet', { id, text }),
    pickOutputDir: (id) => ipcRenderer.invoke('projects:pickOutputDir', { id }),
    setOutputDir: (id, dir) => ipcRenderer.invoke('projects:setOutputDir', { id, dir }),
    effectiveOutputDir: (id) => ipcRenderer.invoke('projects:effectiveOutputDir', { id }),
    // O30: user-invoked drift scan — findings land in the DEBT ledger.
    drift: (input) => ipcRenderer.invoke('project:drift', input)
  },

  // Authored per-project sub-agent definitions.
  agents: {
    list: (projectId) => ipcRenderer.invoke('agents:list', { projectId }),
    create: (input) => ipcRenderer.invoke('agents:create', input),
    update: (id, patch) => ipcRenderer.invoke('agents:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('agents:remove', { id })
  },

  // Per-turn telemetry (read-only).
  metrics: {
    listByChat: (chatId) => ipcRenderer.invoke('metrics:listByChat', { chatId }),
    listByProject: (projectId) => ipcRenderer.invoke('metrics:listByProject', { projectId })
  },

  // Small key/value store; projectId omitted/null = global.
  settings: {
    get: (key, projectId = null) => ipcRenderer.invoke('settings:get', { key, projectId }),
    set: (key, value, projectId = null) => ipcRenderer.invoke('settings:set', { key, value, projectId })
  },

  // Meta-evaluator — critique a turn digest with a chosen model.
  evaluate: {
    run: (input) => ipcRenderer.invoke('evaluate:run', input)
  },

  chats: {
    list: (projectId) => ipcRenderer.invoke('chats:list', { projectId }),
    create: (input) => ipcRenderer.invoke('chats:create', input),
    rename: (id, title) => ipcRenderer.invoke('chats:rename', { id, title }),
    setModel: (id, model) => ipcRenderer.invoke('chats:setModel', { id, model }),
    setMode: (id, mode) => ipcRenderer.invoke('chats:setMode', { id, mode }),
    variables: (id) => ipcRenderer.invoke('chats:variables', { id }),
    setVariable: (id, key, value) => ipcRenderer.invoke('chats:setVariable', { id, key, value }),
    archive: (id) => ipcRenderer.invoke('chats:archive', { id })
  },

  messages: {
    list: (chatId) => ipcRenderer.invoke('messages:list', { chatId }),
    add: (input) => ipcRenderer.invoke('messages:add', input),
    rate: (id, rating) => ipcRenderer.invoke('messages:rate', { id, rating })
  },

  documents: {
    list: (projectId) => ipcRenderer.invoke('documents:list', { projectId }),
    create: (input) => ipcRenderer.invoke('documents:create', input),
    linkToChat: (input) => ipcRenderer.invoke('documents:linkToChat', input),
    listByChat: (chatId) => ipcRenderer.invoke('documents:listByChat', { chatId }),
    remove: (id) => ipcRenderer.invoke('documents:remove', { id }),
    ensureCanonical: (projectId) => ipcRenderer.invoke('documents:ensureCanonical', { projectId }),
    read: (id) => ipcRenderer.invoke('documents:read', { id }),
    openPdf: (id) => ipcRenderer.invoke('documents:openPdf', { id }),
    saveUpload: (input) => ipcRenderer.invoke('documents:saveUpload', input),
    toPdf: (id) => ipcRenderer.invoke('documents:toPdf', { id }),
    listFormats: (projectId) => ipcRenderer.invoke('documents:listFormats', { projectId }),
    installFormat: (projectId) => ipcRenderer.invoke('documents:installFormat', { projectId })
  },

  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    create: (input) => ipcRenderer.invoke('skills:create', input),
    update: (id, patch) => ipcRenderer.invoke('skills:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('skills:remove', { id }),
    enabledForProject: (projectId) => ipcRenderer.invoke('skills:enabledForProject', { projectId }),
    setForProject: (input) => ipcRenderer.invoke('skills:setForProject', input),
    importFromMcp: (serverId) => ipcRenderer.invoke('skills:importFromMcp', { serverId })
  },

  // Metadata only — plaintext secrets never cross into the renderer.
  credentials: {
    list: (opts) => ipcRenderer.invoke('credentials:list', opts),
    set: (input) => ipcRenderer.invoke('credentials:set', input),
    remove: (id) => ipcRenderer.invoke('credentials:remove', { id })
  },

  // Model connections. list()/get() return metadata only (no secrets). A secret
  // is only ever sent INTO main (add/update/test); it is never returned.
  providers: {
    registry: () => ipcRenderer.invoke('providers:registry'),
    list: () => ipcRenderer.invoke('providers:list'),
    add: (input) => ipcRenderer.invoke('providers:add', input),
    update: (id, patch) => ipcRenderer.invoke('providers:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('providers:remove', { id }),
    test: (input) => ipcRenderer.invoke('providers:test', input)
  },

  // MCP servers. Metadata only out; env/token only ever sent IN.
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (input) => ipcRenderer.invoke('mcp:add', input),
    update: (id, patch) => ipcRenderer.invoke('mcp:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('mcp:remove', { id }),
    connect: (input) => ipcRenderer.invoke('mcp:connect', input),
    authorize: (id) => ipcRenderer.invoke('mcp:authorize', { id }),
    enabledForProject: (projectId) => ipcRenderer.invoke('mcp:enabledForProject', { projectId }),
    setForProject: (input) => ipcRenderer.invoke('mcp:setForProject', input),
    checkSync: (serverId) => ipcRenderer.invoke('mcp:checkSync', { serverId })
  }
});
