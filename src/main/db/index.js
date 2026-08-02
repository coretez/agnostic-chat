'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Bump this and add a migration block below when the schema changes.
const SCHEMA_VERSION = 7;

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
