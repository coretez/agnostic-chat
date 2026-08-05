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
  output_dir  TEXT,                          -- where generated documents are saved (NULL = <global base>/<name>)
  preferred_model TEXT,                       -- model new chats default to for this project
  cheat_sheet TEXT,                          -- objectives/rules/mode-of-operation brief the planner reads for orientation
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
  variables_json TEXT,                     -- variable-store snapshot: discovered params/derived values carried across turns
  coding_mode INTEGER,                     -- 1 = coding-harness toggle: file/shell tools jailed to the project working_dir
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
  source     TEXT,                        -- chat | upload | user | skill:<name> | agent:<name>
  doc_type   TEXT,                        -- monthly-report | investigation | compliance-assessment | …
  version    INTEGER NOT NULL DEFAULT 1,  -- bumped on same-location resave (prior → .versions/)
  properties_json TEXT,                   -- tenant/company, period/date, case_id, framework, tags, …
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
  tools_json  TEXT,                       -- optional JSON array of MCP tool names this skill needs; null = unscoped (no tool restriction)
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

-- ── project_mcp: which MCP servers are ENABLED for a project (scoping) ───────
-- Opt-out like project_skills: no row = enabled; enabled=0 keeps that server's
-- whole tool catalog out of the project's turns.
CREATE TABLE IF NOT EXISTS project_mcp (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_id  INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, server_id)
);

-- ── Agents: authored, per-project sub-agent definitions ────────────────────
-- Named roles the orchestrator can `delegate` to (e.g. report-reader, case-checker).
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,                     -- one line: when to delegate to it
  system_prompt TEXT,                     -- the agent's instructions
  model         TEXT,                     -- optional model override (else chat model)
  tools_json    TEXT,                     -- optional JSON array of allowed tool names; null = all
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);

-- ── Turn metrics: per-turn telemetry (real usage + reductions) ─────────────
-- The measurement backbone for the "Efficiency, Measured" phase KPIs.
CREATE TABLE IF NOT EXISTS turn_metrics (
  id                       INTEGER PRIMARY KEY,
  project_id               INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  chat_id                  INTEGER REFERENCES chats(id) ON DELETE CASCADE,
  model                    TEXT,
  measured                 INTEGER NOT NULL DEFAULT 0,  -- 1 = real provider usage, 0 = estimate only
  input_tokens             INTEGER,                     -- real prompt tokens (all model calls this turn)
  output_tokens            INTEGER,
  cached_tokens            INTEGER,                     -- prompt tokens served from cache
  cache_creation_tokens    INTEGER,
  est_input_tokens         INTEGER,                     -- our chars/4 estimate (reconciliation)
  window                   INTEGER,
  skills_available         INTEGER,
  skills_loaded            INTEGER,
  skill_saved_tokens       INTEGER,
  skills_used              TEXT,                        -- JSON array of loaded skill names
  filter_saved_tokens      INTEGER,
  compaction_saved_tokens  INTEGER,
  delegated                INTEGER,                     -- # sub-agents this turn
  delegate_absorbed_tokens INTEGER,                     -- tokens sub-agents kept out of main
  duration_ms              INTEGER,                     -- wall-clock for the whole turn
  planning_failed          INTEGER,                     -- 1 = the context planner call errored/mismatched this turn
  tool_fell_back           INTEGER,                     -- 1 = tool ceiling fell back to the full catalog (no usable picks)
  plan_steps               INTEGER,                     -- steps in the derived plan (0/NULL = flat-loop turn)
  plan_refines             INTEGER,                     -- reactive re-plans fired by stuck steps this turn
  vars_captured            INTEGER,                     -- variable-store entries captured this turn
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_project ON turn_metrics(project_id);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_chat ON turn_metrics(chat_id);

-- ── Task metrics: per-task duration + tokens (tool calls, sub-agents, …) ─────
-- Finer than turn_metrics: "how long does the monthly-report task take, and how
-- many tokens does it use" — aggregatable over time.
CREATE TABLE IF NOT EXISTS task_metrics (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  chat_id     INTEGER REFERENCES chats(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,     -- 'tool' | 'subagent' | 'select' | 'merge' | 'eval'
  label       TEXT,              -- tool/agent name or task description
  tokens      INTEGER,           -- tokens attributed to this task
  duration_ms INTEGER,
  ok          INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_metrics_chat ON task_metrics(chat_id);
CREATE INDEX IF NOT EXISTS idx_task_metrics_kind ON task_metrics(kind, label);

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
