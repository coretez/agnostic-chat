-- Agnostic Chat schema (SQLite via node:sqlite).
-- Project-centric: the project is the durable container; chats, documents,
-- skills, and credentials all hang off it. Designed to be portable to Postgres.

PRAGMA foreign_keys = ON;

-- ── Projects: the top-level organizing unit ────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE,
  description TEXT,
  working_dir TEXT,                          -- folder on disk the project is anchored to
  preferred_model TEXT,                       -- model new chats default to for this project
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

-- ── Chats: conversations within a project ──────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT,
  model       TEXT,                       -- provider/model used for this chat
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id);

-- ── Messages: within a chat ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,               -- user | assistant | system | tool
  content    TEXT NOT NULL,
  metadata   TEXT,                        -- JSON blob (tokens, tool calls, etc.)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);

-- ── Documents: PROJECT-scoped, not chat-scoped (the core fix) ───────────────
CREATE TABLE IF NOT EXISTS documents (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  path       TEXT,                        -- location on disk, or NULL if inline
  content    TEXT,                        -- optional inline content
  mime_type  TEXT,
  source     TEXT,                        -- chat | upload | user
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);

-- ── chat_documents: many-to-many between chats and documents ────────────────
-- A document belongs to the project; any number of chats may create/reference it.
CREATE TABLE IF NOT EXISTS chat_documents (
  chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL DEFAULT 'referenced',  -- created | referenced | edited
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, document_id)
);

-- ── Skills: definitions. Global (project_id NULL) or authored for a project ─
CREATE TABLE IF NOT EXISTS skills (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  definition  TEXT,                       -- markdown / JSON of the skill
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── project_skills: which skills are ENABLED for a project (scoping) ─────────
-- This is what stops another project's skills from polluting decisions.
CREATE TABLE IF NOT EXISTS project_skills (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id   INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, skill_id)
);

-- ── Credentials: API keys / tokens, ENCRYPTED at rest ──────────────────────
-- secret_ciphertext holds safeStorage-encrypted bytes; plaintext never touches disk.
CREATE TABLE IF NOT EXISTS credentials (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global
  provider          TEXT NOT NULL,        -- anthropic | openai | ...
  label             TEXT,
  secret_ciphertext BLOB NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credentials_project ON credentials(project_id);

-- ── Settings: key/value, optionally project-scoped ─────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global
  key        TEXT NOT NULL,
  value      TEXT,
  UNIQUE (project_id, key)
);

-- ── Providers: model connections (OpenAI, Anthropic, Qwen, Kimi, Gemini) ────
-- App-global (not project-scoped). The API key is encrypted at rest exactly like
-- credentials; only the ciphertext lives here and the plaintext is recovered in
-- the main process when calling the provider.
CREATE TABLE IF NOT EXISTS providers (
  id                INTEGER PRIMARY KEY,
  type              TEXT NOT NULL,        -- openai | anthropic | qwen | kimi | gemini
  label             TEXT,
  base_url          TEXT,
  secret_ciphertext BLOB,                 -- encrypted API key (NULL if keyless)
  enabled           INTEGER NOT NULL DEFAULT 1,
  default_model     TEXT,
  fast_model        TEXT,                 -- cheap model for titles/summaries/compression
  models_json       TEXT,                 -- cached model ids from last successful fetch
  status            TEXT,                 -- unknown | ok | error
  status_detail     TEXT,
  last_checked_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── MCP servers: Model Context Protocol tool servers ───────────────────────
-- App-global. stdio (command/args/env) or http (url/token). Any secret material
-- (env vars, bearer token) is encrypted at rest exactly like provider keys.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  transport         TEXT NOT NULL DEFAULT 'stdio',  -- stdio | http
  command           TEXT,                 -- stdio: executable
  args_json         TEXT,                 -- stdio: JSON array of args
  url               TEXT,                 -- http: endpoint
  secret_ciphertext BLOB,                 -- encrypted JSON: {env:{...}} or {token:'...'}
  enabled           INTEGER NOT NULL DEFAULT 1,
  tools_json        TEXT,                 -- cached tools [{name,description}] from last connect
  status            TEXT,                 -- unknown | ok | error
  status_detail     TEXT,
  last_checked_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
