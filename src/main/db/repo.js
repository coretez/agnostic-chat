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
  },
  setCheatSheet(id, text) {
    getDb()
      .prepare("UPDATE projects SET cheat_sheet = ?, updated_at = datetime('now') WHERE id = ?")
      .run(text || null, id);
    return projects.get(id);
  },
  setOutputDir(id, dir) {
    getDb()
      .prepare("UPDATE projects SET output_dir = ?, updated_at = datetime('now') WHERE id = ?")
      .run(dir || null, id);
    return projects.get(id);
  }
};

// ── Turn metrics: per-turn telemetry ────────────────────────────────────────
const metrics = {
  record(m = {}) {
    const db = getDb();
    const info = db.prepare(
      `INSERT INTO turn_metrics
        (project_id, chat_id, model, measured, input_tokens, output_tokens, cached_tokens, cache_creation_tokens,
         est_input_tokens, window, skills_available, skills_loaded, skill_saved_tokens, skills_used,
         filter_saved_tokens, compaction_saved_tokens, delegated, delegate_absorbed_tokens, duration_ms,
         planning_failed, tool_fell_back, plan_steps, plan_refines, vars_captured)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      m.projectId ?? null, m.chatId ?? null, m.model ?? null, m.measured ? 1 : 0,
      m.inputTokens ?? null, m.outputTokens ?? null, m.cachedTokens ?? null, m.cacheCreationTokens ?? null,
      m.estInputTokens ?? null, m.window ?? null, m.skillsAvailable ?? null, m.skillsLoaded ?? null,
      m.skillSavedTokens ?? null, m.skillsUsed ? JSON.stringify(m.skillsUsed) : null,
      m.filterSavedTokens ?? null, m.compactionSavedTokens ?? null, m.delegated ?? null, m.delegateAbsorbedTokens ?? null,
      m.durationMs ?? null, m.planningFailed ? 1 : 0, m.toolFellBack ? 1 : 0,
      m.planSteps ?? null, m.planRefines ?? null, m.varsCaptured ?? null
    );
    return info.lastInsertRowid;
  },
  listByChat(chatId, limit = 200) {
    return getDb().prepare('SELECT * FROM turn_metrics WHERE chat_id = ? ORDER BY id ASC LIMIT ?').all(chatId, limit);
  },
  listByProject(projectId, limit = 500) {
    return getDb().prepare('SELECT * FROM turn_metrics WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit);
  },
  /** Per-task rows (tool calls, sub-agents, …) for one turn. */
  recordTasks(tasks = []) {
    if (!tasks.length) return;
    const stmt = getDb().prepare('INSERT INTO task_metrics (project_id, chat_id, kind, label, tokens, duration_ms, ok) VALUES (?,?,?,?,?,?,?)');
    for (const t of tasks) stmt.run(t.projectId ?? null, t.chatId ?? null, t.kind, t.label ?? null, t.tokens ?? null, t.durationMs ?? null, t.ok === false ? 0 : 1);
  },
  tasksByChat(chatId, limit = 500) {
    return getDb().prepare('SELECT * FROM task_metrics WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit);
  },
  taskSummary(projectId, limit = 50) {
    // avg duration + tokens per (kind, label) — "how long does task X take"
    return getDb().prepare(
      `SELECT kind, label, COUNT(*) runs, ROUND(AVG(duration_ms)) avg_ms, ROUND(AVG(tokens)) avg_tokens
       FROM task_metrics WHERE project_id = ? GROUP BY kind, label ORDER BY runs DESC LIMIT ?`
    ).all(projectId, limit);
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
  get(id) {
    return getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id);
  },
  listByProject(projectId) {
    return getDb()
      .prepare('SELECT * FROM chats WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC')
      .all(projectId);
  },
  // Chat mode: work (general agentic) | documents (deliverables are saved
  // docs) | code (jailed file/shell harness). coding_mode stays in sync for
  // anything still reading the old boolean.
  setMode(id, mode) {
    const m = ['work', 'documents', 'code'].includes(mode) ? mode : 'work';
    getDb().prepare("UPDATE chats SET mode = ?, coding_mode = ?, updated_at = datetime('now') WHERE id = ?")
      .run(m, m === 'code' ? 1 : 0, id);
  },
  rename(id, title) {
    getDb().prepare("UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
  },
  setModel(id, model) {
    getDb().prepare("UPDATE chats SET model = ?, updated_at = datetime('now') WHERE id = ?").run(model || null, id);
  },
  archive(id) {
    getDb().prepare("UPDATE chats SET archived_at = datetime('now') WHERE id = ?").run(id);
  },
  // Variable store (working memory) persistence — opaque JSON snapshot; the
  // VariableStore class owns its shape. NULL until a turn captures something.
  getVariables(id) {
    const row = getDb().prepare('SELECT variables_json FROM chats WHERE id = ?').get(id);
    return row ? (row.variables_json || null) : null;
  },
  setVariables(id, json) {
    getDb().prepare("UPDATE chats SET variables_json = ?, updated_at = datetime('now') WHERE id = ?").run(json || null, id);
  },
  // One-line session summary (Librarian) — updated_at untouched: filing a
  // session must not bump it above chats the user actually worked in.
  setSummary(id, summary) {
    getDb().prepare('UPDATE chats SET summary = ? WHERE id = ?').run(summary || null, id);
  }
};

// ── Tags: faceted organization over documents and chats (Librarian, O31) ────
const TAG_FACETS = ['topic', 'kind', 'entity', 'period', 'status'];
function tagSlug(s) {
  return String(s == null ? '' : s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
const tags = {
  FACETS: TAG_FACETS,
  slug: tagSlug,
  /** Find-or-create by (project, facet, normalized name). The slug is the
   *  dedupe key, so "Monthly Report" / "monthly_report" land on one tag. */
  ensure(projectId, facet, name) {
    const f = TAG_FACETS.includes(facet) ? facet : null;
    const slug = tagSlug(name);
    if (!f || !slug) return null;
    const db = getDb();
    const hit = db.prepare('SELECT * FROM tags WHERE project_id = ? AND facet = ? AND slug = ?').get(projectId, f, slug);
    if (hit) return hit;
    const info = db.prepare('INSERT INTO tags (project_id, facet, slug, name) VALUES (?, ?, ?, ?)')
      .run(projectId, f, slug, String(name).trim().slice(0, 80));
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(info.lastInsertRowid);
  },
  /** All of a project's tags with usage counts — the vocabulary the librarian
   *  is told to prefer, and the filter rail's data. */
  listByProject(projectId) {
    return getDb().prepare(`
      SELECT t.*,
        (SELECT COUNT(*) FROM document_tags dt WHERE dt.tag_id = t.id) AS doc_count,
        (SELECT COUNT(*) FROM chat_tags ct WHERE ct.tag_id = t.id) AS chat_count
      FROM tags t WHERE t.project_id = ?
      ORDER BY t.facet, t.slug`).all(projectId);
  },
  tagDocument(documentId, tagId, source = 'librarian') {
    getDb().prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id, source) VALUES (?, ?, ?)').run(documentId, tagId, source);
  },
  tagChat(chatId, tagId, source = 'librarian') {
    getDb().prepare('INSERT OR IGNORE INTO chat_tags (chat_id, tag_id, source) VALUES (?, ?, ?)').run(chatId, tagId, source);
  },
  untagDocument(documentId, tagId) {
    getDb().prepare('DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?').run(documentId, tagId);
  },
  untagChat(chatId, tagId) {
    getDb().prepare('DELETE FROM chat_tags WHERE chat_id = ? AND tag_id = ?').run(chatId, tagId);
  },
  forDocument(documentId) {
    return getDb().prepare('SELECT t.*, dt.source AS tag_source FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = ? ORDER BY t.facet, t.slug').all(documentId);
  },
  forChat(chatId) {
    return getDb().prepare('SELECT t.*, ct.source AS tag_source FROM chat_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.chat_id = ? ORDER BY t.facet, t.slug').all(chatId);
  },
  /** Bulk fetch for list views: {itemId: [tag,…]} for a whole project. */
  forProjectDocuments(projectId) {
    const out = {};
    for (const r of getDb().prepare('SELECT dt.document_id AS item, t.* FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE t.project_id = ?').all(projectId)) {
      (out[r.item] = out[r.item] || []).push(r);
    }
    return out;
  },
  forProjectChats(projectId) {
    const out = {};
    for (const r of getDb().prepare('SELECT ct.chat_id AS item, t.* FROM chat_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.project_id = ?').all(projectId)) {
      (out[r.item] = out[r.item] || []).push(r);
    }
    return out;
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
  },
  // Feedback: 1 (helpful), -1 (not), null (cleared).
  setRating(id, rating) {
    const r = rating === 1 || rating === -1 ? rating : null;
    getDb().prepare('UPDATE messages SET rating = ? WHERE id = ?').run(r, id);
  }
};

// ── Documents (project-scoped) + chat links ────────────────────────────────
function withProps(d) {
  return { ...d, properties: d.properties_json ? (() => { try { return JSON.parse(d.properties_json); } catch { return null; } })() : null };
}
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
      .all(projectId)
      .map(withProps);
  },
  get(id) {
    const d = getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id);
    return d ? withProps(d) : null;
  },
  remove(id) { getDb().prepare('DELETE FROM documents WHERE id = ?').run(id); },
  /** Re-point an indexed document at a new on-disk location (canonical-path migration). */
  repath(id, p) {
    getDb().prepare("UPDATE documents SET path = ?, updated_at = datetime('now') WHERE id = ?").run(p, id);
  },
  /**
   * Register (or re-version) a generated document in the index. Keyed by
   * (project, path): re-saving the same location updates the row and bumps the
   * version rather than creating duplicate index entries.
   */
  saveGenerated({ projectId, title, path: p, mimeType = null, source = 'chat', docType = null, version = 1, properties = null }) {
    const db = getDb();
    const props = properties ? JSON.stringify(properties) : null;
    const existing = db.prepare('SELECT id FROM documents WHERE project_id = ? AND path = ?').get(projectId, p);
    if (existing) {
      db.prepare("UPDATE documents SET title=?, mime_type=?, source=?, doc_type=?, version=?, properties_json=?, updated_at=datetime('now') WHERE id=?")
        .run(title, mimeType, source, docType, version, props, existing.id);
      return documents.get(existing.id);
    }
    const info = db.prepare('INSERT INTO documents (project_id, title, path, mime_type, source, doc_type, version, properties_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(projectId, title, p, mimeType, source, docType, version, props);
    return documents.get(info.lastInsertRowid);
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
// withTools: decorate a raw row with a parsed `.tools` array (or null = unscoped),
// same shape as agents' `.tools` — lets the orchestrator filter its MCP toolset
// down to only what a selected skill declares it needs (dynamic tool binding).
function withTools(row) {
  return row ? { ...row, tools: row.tools_json ? JSON.parse(row.tools_json) : null } : null;
}
const skills = {
  create({ name, description = null, definition = null, tools = null }) {
    const db = getDb();
    // Names are identities (tool ceilings, MCP upserts, and the planner all
    // key on them) — a duplicate is always a mistake, refuse it clearly.
    const dup = db.prepare('SELECT id FROM skills WHERE name = ?').get(name);
    if (dup) throw new Error(`a skill named "${name}" already exists (id ${dup.id}) — update it instead`);
    const info = db
      .prepare('INSERT INTO skills (name, description, definition, tools_json) VALUES (?, ?, ?, ?)')
      .run(name, description, definition, tools ? JSON.stringify(tools) : null);
    return withTools(db.prepare('SELECT * FROM skills WHERE id = ?').get(info.lastInsertRowid));
  },
  list() {
    return getDb().prepare('SELECT * FROM skills ORDER BY name ASC').all().map(withTools);
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
      .all(projectId)
      .map(withTools);
  },
  setForProject({ projectId, skillId, enabled = true }) {
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO project_skills (project_id, skill_id, enabled) VALUES (?, ?, ?)'
      )
      .run(projectId, skillId, enabled ? 1 : 0);
  },
  get(id) { return withTools(getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id)); },
  isEnabled(projectId, skillId) {
    // Opt-out: enabled unless an explicit row disables it.
    const row = getDb().prepare('SELECT enabled FROM project_skills WHERE project_id = ? AND skill_id = ?').get(projectId, skillId);
    return row ? !!row.enabled : true;
  },
  update(id, { name, description, definition, tools }) {
    const db = getDb();
    const sets = []; const vals = [];
    if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
    if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
    if (definition !== undefined) { sets.push('definition = ?'); vals.push(definition); }
    if (tools !== undefined) { sets.push('tools_json = ?'); vals.push(tools ? JSON.stringify(tools) : null); }
    if (!sets.length) return skills.get(id);
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return skills.get(id);
  },
  remove(id) { getDb().prepare('DELETE FROM skills WHERE id = ?').run(id); },
  /** Insert or update by name (used when importing from an MCP server). */
  upsertByName({ name, description = null, definition = null, tools }) {
    const existing = getDb().prepare('SELECT id FROM skills WHERE name = ?').get(name);
    // tools left `undefined` (import didn't derive a scope this time) must NOT
    // clear an existing skill's tools_json — update()'s `!== undefined` guard
    // preserves whatever's already there (a prior import's scope, or a manual
    // one authored in the UI). Only an explicit array/null overwrites it.
    if (existing) return skills.update(existing.id, { description, definition, tools });
    return skills.create({ name, description, definition, tools: tools ?? null });
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

// Same columns as MCP_COLS but table-qualified for joins (never selects the
// raw ciphertext — these rows can cross to the renderer).
const MCP_COLS_M =
  'm.id, m.name, m.transport, m.command, m.args_json, m.url, m.enabled, m.tools_json, m.status, m.status_detail, m.last_checked_at, m.created_at, m.updated_at, (m.secret_ciphertext IS NOT NULL) AS has_secret';

const mcp = {
  list() {
    return getDb().prepare(`SELECT ${MCP_COLS} FROM mcp_servers ORDER BY created_at ASC`).all().map(shapeMcp);
  },
  /**
   * Servers ENABLED for a project. Opt-out like project_skills: no project_mcp
   * row = enabled; an explicit enabled=0 row excludes the server's catalog.
   */
  listEnabledForProject(projectId) {
    return getDb()
      .prepare(
        `SELECT ${MCP_COLS_M} FROM mcp_servers m
         LEFT JOIN project_mcp pm ON pm.server_id = m.id AND pm.project_id = ?
         WHERE pm.enabled IS NULL OR pm.enabled = 1
         ORDER BY m.created_at ASC`
      )
      .all(projectId)
      .map(shapeMcp);
  },
  setForProject({ projectId, serverId, enabled = true }) {
    getDb()
      .prepare('INSERT OR REPLACE INTO project_mcp (project_id, server_id, enabled) VALUES (?, ?, ?)')
      .run(projectId, serverId, enabled ? 1 : 0);
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

module.exports = { projects, chats, messages, documents, skills, credentials, providers, mcp, settings, agents, metrics, tags, slugify };
