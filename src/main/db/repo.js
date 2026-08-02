'use strict';

const { getDb } = require('./index');
const secrets = require('../secrets');

/** Make a URL-safe slug from a name (best-effort, uniqueness enforced by caller). */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ── Projects ────────────────────────────────────────────────────────────────
const projects = {
  create({ name, description = null }) {
    const db = getDb();
    const info = db
      .prepare('INSERT INTO projects (name, slug, description) VALUES (?, ?, ?)')
      .run(name, slugify(name), description);
    return projects.get(info.lastInsertRowid);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
  },
  list({ includeArchived = false } = {}) {
    const sql = includeArchived
      ? 'SELECT * FROM projects ORDER BY updated_at DESC'
      : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY updated_at DESC';
    return getDb().prepare(sql).all();
  },
  rename(id, name) {
    getDb()
      .prepare("UPDATE projects SET name = ?, slug = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, slugify(name), id);
    return projects.get(id);
  },
  archive(id) {
    getDb()
      .prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?")
      .run(id);
  },
  setWorkingDir(id, dir) {
    getDb()
      .prepare("UPDATE projects SET working_dir = ?, updated_at = datetime('now') WHERE id = ?")
      .run(dir, id);
    return projects.get(id);
  },
  setPreferredModel(id, model) {
    getDb()
      .prepare("UPDATE projects SET preferred_model = ?, updated_at = datetime('now') WHERE id = ?")
      .run(model || null, id);
    return projects.get(id);
  }
};

// ── Settings: small key/value store (global when project_id is NULL) ─────────
const settings = {
  get(key, projectId = null) {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ? AND project_id IS ?')
      .get(key, projectId);
    return row ? row.value : null;
  },
  set(key, value, projectId = null) {
    const db = getDb();
    // NULLs are distinct in a UNIQUE index, so ON CONFLICT is unreliable for
    // global (project_id IS NULL) rows. Update-else-insert handles both cases.
    const res = db
      .prepare('UPDATE settings SET value = ? WHERE key = ? AND project_id IS ?')
      .run(value, key, projectId);
    if (res.changes === 0) {
      db.prepare('INSERT INTO settings (project_id, key, value) VALUES (?, ?, ?)').run(projectId, key, value);
    }
    return value;
  }
};

// ── Agents: authored per-project sub-agent definitions ──────────────────────
const agents = {
  listByProject(projectId) {
    return getDb().prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY name').all(projectId)
      .map((a) => ({ ...a, tools: a.tools_json ? JSON.parse(a.tools_json) : null }));
  },
  get(id) {
    const a = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return a ? { ...a, tools: a.tools_json ? JSON.parse(a.tools_json) : null } : null;
  },
  getByName(projectId, name) {
    const a = getDb().prepare('SELECT * FROM agents WHERE project_id = ? AND name = ? COLLATE NOCASE').get(projectId, name);
    return a ? { ...a, tools: a.tools_json ? JSON.parse(a.tools_json) : null } : null;
  },
  create({ projectId, name, description = null, systemPrompt = null, model = null, tools = null }) {
    const info = getDb()
      .prepare('INSERT INTO agents (project_id, name, description, system_prompt, model, tools_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(projectId, name, description, systemPrompt, model, tools ? JSON.stringify(tools) : null);
    return agents.get(info.lastInsertRowid);
  },
  update(id, patch = {}) {
    const sets = [], vals = [];
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (patch.description !== undefined) { sets.push('description = ?'); vals.push(patch.description); }
    if (patch.systemPrompt !== undefined) { sets.push('system_prompt = ?'); vals.push(patch.systemPrompt); }
    if (patch.model !== undefined) { sets.push('model = ?'); vals.push(patch.model || null); }
    if (patch.tools !== undefined) { sets.push('tools_json = ?'); vals.push(patch.tools ? JSON.stringify(patch.tools) : null); }
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    getDb().prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return agents.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM agents WHERE id = ?').run(id); }
};

// ── Chats & messages ──────────────────────────────────────────────────────
const chats = {
  create({ projectId, title = null, model = null }) {
    const db = getDb();
    const info = db
      .prepare('INSERT INTO chats (project_id, title, model) VALUES (?, ?, ?)')
      .run(projectId, title, model);
    return db.prepare('SELECT * FROM chats WHERE id = ?').get(info.lastInsertRowid);
  },
  listByProject(projectId) {
    return getDb()
      .prepare('SELECT * FROM chats WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC')
      .all(projectId);
  },
  rename(id, title) {
    getDb().prepare("UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
  },
  setModel(id, model) {
    getDb().prepare("UPDATE chats SET model = ?, updated_at = datetime('now') WHERE id = ?").run(model || null, id);
  },
  archive(id) {
    getDb().prepare("UPDATE chats SET archived_at = datetime('now') WHERE id = ?").run(id);
  }
};

const messages = {
  add({ chatId, role, content, metadata = null }) {
    const db = getDb();
    const info = db
      .prepare('INSERT INTO messages (chat_id, role, content, metadata) VALUES (?, ?, ?, ?)')
      .run(chatId, role, content, metadata ? JSON.stringify(metadata) : null);
    db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(chatId);
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  },
  listByChat(chatId) {
    return getDb()
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC')
      .all(chatId);
  }
};

// ── Documents (project-scoped) + chat links ────────────────────────────────
const documents = {
  create({ projectId, title, path = null, content = null, mimeType = null, source = 'user' }) {
    const db = getDb();
    const info = db
      .prepare(
        'INSERT INTO documents (project_id, title, path, content, mime_type, source) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(projectId, title, path, content, mimeType, source);
    return db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid);
  },
  listByProject(projectId) {
    return getDb()
      .prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId);
  },
  /** Link an existing document to a chat (created | referenced | edited). */
  linkToChat({ chatId, documentId, relation = 'referenced' }) {
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO chat_documents (chat_id, document_id, relation) VALUES (?, ?, ?)'
      )
      .run(chatId, documentId, relation);
  },
  listByChat(chatId) {
    return getDb()
      .prepare(
        `SELECT d.*, cd.relation FROM documents d
         JOIN chat_documents cd ON cd.document_id = d.id
         WHERE cd.chat_id = ? ORDER BY d.updated_at DESC`
      )
      .all(chatId);
  }
};

// ── Skills + per-project scoping ───────────────────────────────────────────
const skills = {
  create({ name, description = null, definition = null }) {
    const db = getDb();
    const info = db
      .prepare('INSERT INTO skills (name, description, definition) VALUES (?, ?, ?)')
      .run(name, description, definition);
    return db.prepare('SELECT * FROM skills WHERE id = ?').get(info.lastInsertRowid);
  },
  list() {
    return getDb().prepare('SELECT * FROM skills ORDER BY name ASC').all();
  },
  /**
   * Skills ENABLED for a project — what should actually be in scope.
   * Opt-OUT model: a skill is on by default; it's excluded only when the project
   * has an explicit project_skills row with enabled = 0. (No row = enabled.)
   */
  listEnabledForProject(projectId) {
    return getDb()
      .prepare(
        `SELECT s.* FROM skills s
         LEFT JOIN project_skills ps ON ps.skill_id = s.id AND ps.project_id = ?
         WHERE ps.enabled IS NULL OR ps.enabled = 1
         ORDER BY s.name ASC`
      )
      .all(projectId);
  },
  setForProject({ projectId, skillId, enabled = true }) {
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO project_skills (project_id, skill_id, enabled) VALUES (?, ?, ?)'
      )
      .run(projectId, skillId, enabled ? 1 : 0);
  },
  get(id) { return getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id); },
  isEnabled(projectId, skillId) {
    // Opt-out: enabled unless an explicit row disables it.
    const row = getDb().prepare('SELECT enabled FROM project_skills WHERE project_id = ? AND skill_id = ?').get(projectId, skillId);
    return row ? !!row.enabled : true;
  },
  update(id, { name, description, definition }) {
    const db = getDb();
    const sets = []; const vals = [];
    if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
    if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
    if (definition !== undefined) { sets.push('definition = ?'); vals.push(definition); }
    if (!sets.length) return skills.get(id);
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return skills.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM skills WHERE id = ?').run(id); },
  /** Insert or update by name (used when importing from an MCP server). */
  upsertByName({ name, description = null, definition = null }) {
    const existing = getDb().prepare('SELECT id FROM skills WHERE name = ?').get(name);
    if (existing) return skills.update(existing.id, { description, definition });
    return skills.create({ name, description, definition });
  }
};

// ── Credentials (encrypted at rest) ────────────────────────────────────────
const credentials = {
  /** Store a secret. The plaintext is encrypted here and never persisted raw. */
  set({ projectId = null, provider, label = null, secret }) {
    const db = getDb();
    const ciphertext = secrets.encrypt(secret);
    const info = db
      .prepare(
        'INSERT INTO credentials (project_id, provider, label, secret_ciphertext) VALUES (?, ?, ?, ?)'
      )
      .run(projectId, provider, label, ciphertext);
    return credentials.describe(info.lastInsertRowid);
  },
  /** Metadata only — NEVER returns the secret. Safe to send to the renderer. */
  describe(id) {
    return getDb()
      .prepare('SELECT id, project_id, provider, label, created_at, updated_at FROM credentials WHERE id = ?')
      .get(id);
  },
  /** List metadata for a project (and global). No secrets. */
  list({ projectId = null } = {}) {
    return getDb()
      .prepare(
        `SELECT id, project_id, provider, label, created_at, updated_at FROM credentials
         WHERE project_id IS ? OR project_id IS NULL ORDER BY provider ASC`
      )
      .all(projectId);
  },
  /** Decrypt and return the plaintext secret. Main-process use only. */
  reveal(id) {
    const row = getDb()
      .prepare('SELECT secret_ciphertext FROM credentials WHERE id = ?')
      .get(id);
    if (!row) return null;
    return secrets.decrypt(row.secret_ciphertext);
  },
  remove(id) {
    getDb().prepare('DELETE FROM credentials WHERE id = ?').run(id);
  }
};

// ── Providers (model connections, encrypted key at rest) ───────────────────
const PROVIDER_COLS =
  'id, type, label, base_url, enabled, default_model, fast_model, models_json, status, status_detail, last_checked_at, created_at, updated_at, (secret_ciphertext IS NOT NULL) AS has_secret';

function shapeProvider(row) {
  if (!row) return row;
  return { ...row, enabled: !!row.enabled, has_secret: !!row.has_secret, models: row.models_json ? JSON.parse(row.models_json) : [] };
}

const providers = {
  /** Metadata only (never the secret). Safe for the renderer. */
  list() {
    return getDb().prepare(`SELECT ${PROVIDER_COLS} FROM providers ORDER BY created_at ASC`).all().map(shapeProvider);
  },
  get(id) {
    return shapeProvider(getDb().prepare(`SELECT ${PROVIDER_COLS} FROM providers WHERE id = ?`).get(id));
  },
  add({ type, label = null, baseUrl = null, secret = null, defaultModel = null, fastModel = null, enabled = true, models = null }) {
    const db = getDb();
    const ciphertext = secret ? secrets.encrypt(secret) : null;
    const info = db
      .prepare('INSERT INTO providers (type, label, base_url, secret_ciphertext, enabled, default_model, fast_model, models_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(type, label, baseUrl, ciphertext, enabled ? 1 : 0, defaultModel, fastModel, models ? JSON.stringify(models) : null);
    return providers.get(info.lastInsertRowid);
  },
  /** Patch fields. Pass `secret` only to replace the key; omit to keep it. */
  update(id, patch = {}) {
    const db = getDb();
    const sets = [];
    const vals = [];
    const map = { label: 'label', baseUrl: 'base_url', defaultModel: 'default_model', fastModel: 'fast_model', status: 'status', statusDetail: 'status_detail' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[k]); }
    }
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
    if (patch.models !== undefined) { sets.push('models_json = ?'); vals.push(patch.models ? JSON.stringify(patch.models) : null); }
    if (patch.secret !== undefined && patch.secret) { sets.push('secret_ciphertext = ?'); vals.push(secrets.encrypt(patch.secret)); }
    if (patch.markChecked) { sets.push("last_checked_at = datetime('now')"); }
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return providers.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM providers WHERE id = ?').run(id); },
  /** Decrypt the API key. Main-process use only — never exposed over IPC. */
  reveal(id) {
    const row = getDb().prepare('SELECT secret_ciphertext FROM providers WHERE id = ?').get(id);
    if (!row || !row.secret_ciphertext) return null;
    return secrets.decrypt(row.secret_ciphertext);
  }
};

// ── MCP servers (encrypted env/token at rest) ──────────────────────────────
const MCP_COLS =
  'id, name, transport, command, args_json, url, enabled, tools_json, status, status_detail, last_checked_at, created_at, updated_at, (secret_ciphertext IS NOT NULL) AS has_secret';

function shapeMcp(row) {
  if (!row) return row;
  return {
    ...row,
    enabled: !!row.enabled,
    has_secret: !!row.has_secret,
    args: row.args_json ? JSON.parse(row.args_json) : [],
    tools: row.tools_json ? JSON.parse(row.tools_json) : []
  };
}

const mcp = {
  list() {
    return getDb().prepare(`SELECT ${MCP_COLS} FROM mcp_servers ORDER BY created_at ASC`).all().map(shapeMcp);
  },
  get(id) {
    return shapeMcp(getDb().prepare(`SELECT ${MCP_COLS} FROM mcp_servers WHERE id = ?`).get(id));
  },
  add({ name, transport = 'stdio', command = null, args = null, url = null, secret = null, enabled = true, tools = null }) {
    const db = getDb();
    const ciphertext = secret ? secrets.encrypt(JSON.stringify(secret)) : null;
    const info = db
      .prepare('INSERT INTO mcp_servers (name, transport, command, args_json, url, secret_ciphertext, enabled, tools_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, transport, command, args ? JSON.stringify(args) : null, url, ciphertext, enabled ? 1 : 0, tools ? JSON.stringify(tools) : null);
    return mcp.get(info.lastInsertRowid);
  },
  update(id, patch = {}) {
    const db = getDb();
    const sets = [];
    const vals = [];
    const map = { name: 'name', transport: 'transport', command: 'command', url: 'url', status: 'status', statusDetail: 'status_detail' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[k]); }
    }
    if (patch.args !== undefined) { sets.push('args_json = ?'); vals.push(patch.args ? JSON.stringify(patch.args) : null); }
    if (patch.tools !== undefined) { sets.push('tools_json = ?'); vals.push(patch.tools ? JSON.stringify(patch.tools) : null); }
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
    if (patch.secret !== undefined && patch.secret) { sets.push('secret_ciphertext = ?'); vals.push(secrets.encrypt(JSON.stringify(patch.secret))); }
    if (patch.markChecked) { sets.push("last_checked_at = datetime('now')"); }
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return mcp.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id); },
  /** Decrypt the secret blob ({env}/{token}). Main-process only. */
  reveal(id) {
    const row = getDb().prepare('SELECT secret_ciphertext FROM mcp_servers WHERE id = ?').get(id);
    if (!row || !row.secret_ciphertext) return null;
    try { return JSON.parse(secrets.decrypt(row.secret_ciphertext)); } catch { return null; }
  }
};

module.exports = { projects, chats, messages, documents, skills, credentials, providers, mcp, settings, agents, slugify };
