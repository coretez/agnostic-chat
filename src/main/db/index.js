'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Bump this and add a migration block below when the schema changes.
const SCHEMA_VERSION = 19;

let db = null;

/**
 * Open (once) and migrate the database.
 * @param {string} dbPath absolute path to the sqlite file
 * @returns {DatabaseSync}
 */
function openDatabase(dbPath) {
  if (db) return db;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  migrate(db);
  return db;
}

function migrate(database) {
  const { user_version: current } = database
    .prepare('PRAGMA user_version')
    .get();

  if (current < 1) {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    database.exec(schema);
  }

  // v2: model-provider connections. Fresh DBs already have it (schema.sql);
  // this adds it to DBs created at v1.
  if (current < 2) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id                INTEGER PRIMARY KEY,
        type              TEXT NOT NULL,
        label             TEXT,
        base_url          TEXT,
        secret_ciphertext BLOB,
        enabled           INTEGER NOT NULL DEFAULT 1,
        default_model     TEXT,
        models_json       TEXT,
        status            TEXT,
        status_detail     TEXT,
        last_checked_at   TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // v3: MCP servers. Fresh DBs already have it (schema.sql); add it to older DBs.
  if (current < 3) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id                INTEGER PRIMARY KEY,
        name              TEXT NOT NULL,
        transport         TEXT NOT NULL DEFAULT 'stdio',
        command           TEXT,
        args_json         TEXT,
        url               TEXT,
        secret_ciphertext BLOB,
        enabled           INTEGER NOT NULL DEFAULT 1,
        tools_json        TEXT,
        status            TEXT,
        status_detail     TEXT,
        last_checked_at   TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // v4: providers.fast_model (cheap model for summaries/compression).
  if (current < 4) {
    const cols = database.prepare('PRAGMA table_info(providers)').all().map((c) => c.name);
    if (!cols.includes('fast_model')) database.exec('ALTER TABLE providers ADD COLUMN fast_model TEXT');
  }

  // v5: projects.working_dir (folder the project is anchored to).
  if (current < 5) {
    const cols = database.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    if (!cols.includes('working_dir')) database.exec('ALTER TABLE projects ADD COLUMN working_dir TEXT');
  }

  // v6: projects.preferred_model (model new chats default to for this project).
  if (current < 6) {
    const cols = database.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    if (!cols.includes('preferred_model')) database.exec('ALTER TABLE projects ADD COLUMN preferred_model TEXT');
  }

  // v7: authored per-project sub-agent definitions.
  if (current < 7) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id            INTEGER PRIMARY KEY,
        project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT,
        system_prompt TEXT,
        model         TEXT,
        tools_json    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    `);
  }

  // v8: turn_metrics telemetry table.
  if (current < 8) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS turn_metrics (
        id INTEGER PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
        model TEXT,
        measured INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, cache_creation_tokens INTEGER,
        est_input_tokens INTEGER, window INTEGER,
        skills_available INTEGER, skills_loaded INTEGER, skill_saved_tokens INTEGER, skills_used TEXT,
        filter_saved_tokens INTEGER, compaction_saved_tokens INTEGER,
        delegated INTEGER, delegate_absorbed_tokens INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_turn_metrics_project ON turn_metrics(project_id);
      CREATE INDEX IF NOT EXISTS idx_turn_metrics_chat ON turn_metrics(chat_id);
    `);
  }

  // v9: skills.tools_json — optional MCP tool scoping per skill (dynamic tool
  // binding: only offer the model tools a selected skill actually declares).
  if (current < 9) {
    const cols = database.prepare('PRAGMA table_info(skills)').all().map((c) => c.name);
    if (!cols.includes('tools_json')) database.exec('ALTER TABLE skills ADD COLUMN tools_json TEXT');
  }

  // v10: projects.cheat_sheet — a short, persistent objectives/rules/mode-of-
  // operation brief the (future) planner stage reads for project orientation,
  // separate from skills (candidate capabilities) and history (past turns).
  if (current < 10) {
    const cols = database.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    if (!cols.includes('cheat_sheet')) database.exec('ALTER TABLE projects ADD COLUMN cheat_sheet TEXT');
  }

  // v11: task-level timing/tokens + turn duration.
  if (current < 11) {
    const tcols = database.prepare('PRAGMA table_info(turn_metrics)').all().map((c) => c.name);
    if (!tcols.includes('duration_ms')) database.exec('ALTER TABLE turn_metrics ADD COLUMN duration_ms INTEGER');
    database.exec(`
      CREATE TABLE IF NOT EXISTS task_metrics (
        id INTEGER PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, label TEXT, tokens INTEGER, duration_ms INTEGER, ok INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_metrics_chat ON task_metrics(chat_id);
      CREATE INDEX IF NOT EXISTS idx_task_metrics_kind ON task_metrics(kind, label);
    `);
    // Heal DBs that were bumped to v9 under this branch's earlier (task_metrics)
    // definition of v9, so origin's real v9 (skills.tools_json) never ran here.
    const scols = database.prepare('PRAGMA table_info(skills)').all().map((c) => c.name);
    if (!scols.includes('tools_json')) database.exec('ALTER TABLE skills ADD COLUMN tools_json TEXT');
  }

  // v12: whether this turn's context planner failed / fell back to the full
  // tool catalog — makes the fallback rate observable across turns instead of
  // only visible one turn at a time in the INTERNALS tab.
  if (current < 12) {
    const tcols = database.prepare('PRAGMA table_info(turn_metrics)').all().map((c) => c.name);
    if (!tcols.includes('planning_failed')) database.exec('ALTER TABLE turn_metrics ADD COLUMN planning_failed INTEGER');
    if (!tcols.includes('tool_fell_back')) database.exec('ALTER TABLE turn_metrics ADD COLUMN tool_fell_back INTEGER');
  }

  // v13: generated-document management — per-project output dir + rich document
  // metadata (type, version, properties: tenant/period/etc.) for a findable, indexed
  // document library.
  if (current < 13) {
    const pcols = database.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    if (!pcols.includes('output_dir')) database.exec('ALTER TABLE projects ADD COLUMN output_dir TEXT');
    const dcols = database.prepare('PRAGMA table_info(documents)').all().map((c) => c.name);
    if (!dcols.includes('doc_type')) database.exec('ALTER TABLE documents ADD COLUMN doc_type TEXT');
    if (!dcols.includes('version')) database.exec('ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    if (!dcols.includes('properties_json')) database.exec('ALTER TABLE documents ADD COLUMN properties_json TEXT');
  }

  // v14: per-chat variable store (working memory of discovered tool parameters
  // and derived values) — carried across a turn's steps and persisted across the
  // turns of a chat. See the internal planning-architecture record §5.
  if (current < 14) {
    const ccols = database.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);
    if (!ccols.includes('variables_json')) database.exec('ALTER TABLE chats ADD COLUMN variables_json TEXT');
  }

  // v15: plan-and-execute telemetry — measure the planner itself (steps derived,
  // reactive re-plans, variables captured) per turn.
  if (current < 15) {
    const tcols = database.prepare('PRAGMA table_info(turn_metrics)').all().map((c) => c.name);
    if (!tcols.includes('plan_steps')) database.exec('ALTER TABLE turn_metrics ADD COLUMN plan_steps INTEGER');
    if (!tcols.includes('plan_refines')) database.exec('ALTER TABLE turn_metrics ADD COLUMN plan_refines INTEGER');
    if (!tcols.includes('vars_captured')) database.exec('ALTER TABLE turn_metrics ADD COLUMN vars_captured INTEGER');
  }

  // v16: per-chat coding-harness toggle — enables the jailed file/shell tool
  // pack (coding-tools.js) rooted at the project's working_dir.
  if (current < 16) {
    const ccols = database.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);
    if (!ccols.includes('coding_mode')) database.exec('ALTER TABLE chats ADD COLUMN coding_mode INTEGER');
  }

  // v17: per-project MCP server scoping (opt-out, mirrors project_skills).
  if (current < 17) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS project_mcp (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        server_id  INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        enabled    INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project_id, server_id)
      );
    `);
  }

  // v18: three chat modes — work | documents | code. Replaces the boolean
  // coding_mode toggle (kept in sync for anything still reading it).
  if (current < 18) {
    const ccols = database.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);
    if (!ccols.includes('mode')) database.exec('ALTER TABLE chats ADD COLUMN mode TEXT');
    database.exec("UPDATE chats SET mode = CASE WHEN coding_mode = 1 THEN 'code' ELSE 'work' END WHERE mode IS NULL");
  }

  // v19: per-message feedback (thumbs up/down on assistant replies) — part
  // of the O14 glass box: user judgment lands beside the turn's metrics.
  if (current < 19) {
    const mcols = database.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    if (!mcols.includes('rating')) database.exec('ALTER TABLE messages ADD COLUMN rating INTEGER');
  }

  // Future migrations go here as `if (current < N) { ... }` blocks.

  if (current !== SCHEMA_VERSION) {
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

/** @returns {DatabaseSync} the open connection (throws if not opened yet). */
function getDb() {
  if (!db) throw new Error('Database not opened. Call openDatabase() first.');
  return db;
}

module.exports = { openDatabase, getDb, SCHEMA_VERSION };
