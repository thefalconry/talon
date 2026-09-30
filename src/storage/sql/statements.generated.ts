// AUTO-GENERATED FILE — DO NOT EDIT.
// Source of truth: the .sql files in this directory.
// Regenerate with `npm run build:sql` (drift-guarded by sql-embed.test.ts).

/** The complete idempotent schema, ensured on every open (db.ts). */
export const SCHEMA = `-- The complete database schema, ensured on every open (db.ts).
-- Every statement is idempotent (IF NOT EXISTS), so a fresh database
-- gets everything and an existing one gets only what it's missing.
-- Renaming or reshaping something that already shipped needs an
-- explicit upgrade path, not an edit here.

-- Chat history, with an FTS5 full-text index over text + sender.
CREATE TABLE IF NOT EXISTS history_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         TEXT    NOT NULL,
  msg_id          INTEGER NOT NULL,
  sender_id       INTEGER NOT NULL,
  sender_name     TEXT    NOT NULL,
  -- Platform handle without \`@\` (Telegram username / Discord username).
  -- Null for users who have none — display names are not addressable, so
  -- this is what a later reader needs to actually mention someone.
  sender_handle   TEXT,
  text            TEXT    NOT NULL,
  reply_to_msg_id INTEGER,
  timestamp       INTEGER NOT NULL,
  media_type      TEXT,
  sticker_file_id TEXT,
  file_path       TEXT,
  -- Files attached to this message, as a JSON array of
  -- {path,name,size,mimeType,image}. A message can carry several (the
  -- companion's composer stages any number), so file_path above holds
  -- only the first for the pre-multi-file row shape. Null when none.
  attachments     TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_chat ON history_messages(chat_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_chat_msg ON history_messages(chat_id, msg_id);
CREATE INDEX IF NOT EXISTS idx_history_chat_sender ON history_messages(chat_id, sender_id, id);

CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  text,
  sender_name,
  content='history_messages',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history_messages BEGIN
  INSERT INTO history_fts(rowid, text, sender_name)
  VALUES (new.id, new.text, new.sender_name);
END;
CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history_messages BEGIN
  INSERT INTO history_fts(history_fts, rowid, text, sender_name)
  VALUES ('delete', old.id, old.text, old.sender_name);
END;
CREATE TRIGGER IF NOT EXISTS history_au AFTER UPDATE OF text, sender_name ON history_messages BEGIN
  INSERT INTO history_fts(history_fts, rowid, text, sender_name)
  VALUES ('delete', old.id, old.text, old.sender_name);
  INSERT INTO history_fts(rowid, text, sender_name)
  VALUES (new.id, new.text, new.sender_name);
END;

-- Typed memory: one row per claim, with an FTS5 index over subject +
-- text. Kinds are lifecycles, not labels (docs/memory-persona-plan.md
-- §3.1): \`directive\` is durable human intent, \`fact\` is durable and
-- supersedable, \`state\` is keyed (a write replaces the row for that
-- key), \`episode\` decays fast, \`relationship\` and \`reflection\` are the
-- persona layer. Rows are never physically deleted — \`superseded_by\`
-- points at the replacement and \`dropped_at\` is the graveyard, so ids
-- stay stable and every change is revertible.
CREATE TABLE IF NOT EXISTS memory (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- directive | fact | state | episode | relationship | reflection
  kind            TEXT    NOT NULL,
  -- Who or what the claim is about; the retrieval scope.
  subject         TEXT    NOT NULL,
  -- Required for kind='state' (e.g. 'heartbeat.health'), NULL otherwise.
  -- One live row per key is enforced by the store's replaceStateKey,
  -- which supersedes the previous row inside a transaction.
  key             TEXT,
  text            TEXT    NOT NULL,
  -- Provenance: which frontend/chat/actor/turn asserted this.
  source_frontend TEXT,
  source_chat     TEXT,
  source_actor    TEXT,
  source_turn     TEXT,
  -- operator | agent | user_claim | group_chat — the trust tier.
  -- user_claim and group_chat can never be pinned (plan §5).
  trust           TEXT    NOT NULL,
  confidence      REAL    NOT NULL DEFAULT 1.0,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  salience        REAL    NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  -- memory.id of the row that replaced this one; NULL while live.
  superseded_by   INTEGER,
  -- Soft delete: the graveyard, not oblivion.
  dropped_at      INTEGER,
  -- sha256 of kind|subject|key|text — the idempotency key for import.
  content_hash    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_kind_subject ON memory(kind, subject);
CREATE INDEX IF NOT EXISTS idx_memory_key ON memory(key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_salience ON memory(salience);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  subject,
  text,
  content='memory',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, subject, text)
  VALUES (new.id, new.subject, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, subject, text)
  VALUES ('delete', old.id, old.subject, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF subject, text ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, subject, text)
  VALUES ('delete', old.id, old.subject, old.text);
  INSERT INTO memory_fts(rowid, subject, text)
  VALUES (new.id, new.subject, new.text);
END;

-- The audit log: one row per mutation, so every change is diffable and
-- revertible (\`/memory diff\`, \`/memory undo\`). Ops are the reconcile
-- vocabulary of plan §3.3 plus the store's own replace_state. A touch
-- (hit_count / last_seen_at) changes no content and is not audited.
CREATE TABLE IF NOT EXISTS memory_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   INTEGER NOT NULL,
  -- assert | supersede | drop | merge | pin | unpin | replace_state
  op          TEXT    NOT NULL,
  before_text TEXT,
  after_text  TEXT,
  reason      TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_history_memory ON memory_history(memory_id, id);

-- Sessions: real columns rather than a JSON blob. The store's hot
-- paths (recordUsage, incrementTurns, setSessionId) accumulate into
-- individual fields per turn, and the usage counters are numeric
-- accounting data — typed columns keep them queryable and make the
-- whole-row upsert cheap. fastest_response_ms is NULL when no timed
-- turn has been recorded yet (the domain value is Infinity, which
-- JSON could never store — the legacy file held null there too).
CREATE TABLE IF NOT EXISTS sessions (
  chat_id             TEXT    PRIMARY KEY,
  session_id          TEXT,
  session_name        TEXT,
  last_model          TEXT,
  turns               INTEGER NOT NULL DEFAULT 0,
  last_active         INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT 0,
  last_bot_message_id INTEGER,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read    INTEGER NOT NULL DEFAULT 0,
  total_cache_write   INTEGER NOT NULL DEFAULT 0,
  last_prompt_tokens  INTEGER NOT NULL DEFAULT 0,
  context_tokens      INTEGER NOT NULL DEFAULT 0,
  context_window      INTEGER NOT NULL DEFAULT 0,
  num_api_calls       INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd  REAL    NOT NULL DEFAULT 0,
  total_response_ms   REAL    NOT NULL DEFAULT 0,
  last_response_ms    REAL    NOT NULL DEFAULT 0,
  fastest_response_ms REAL,
  -- When the chat's last turn finished; NULL until one has. Read as the
  -- prompt cache's age signal (docs/cache-economics.md), which is why it
  -- is separate from last_active (moved by any session write).
  last_turn_ended_at  INTEGER,
  metrics             TEXT    NOT NULL DEFAULT '{"lifetime":{"counters":{"queries":0,"toolCalls":0,"turnsWithTools":0,"apiCalls":0,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"failedTurns":0,"flowViolationRetries":0,"flowViolationCapExhausted":0,"trailingTextDropped":0},"latency":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"toolCallsByName":{},"backend":{},"cacheHitPercent":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"toolCallsPerTurn":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"apiCallsPerTurn":{"count":0,"sumMs":0,"minMs":null,"maxMs":0}},"buckets":{}}'
);

-- Chat settings: one JSON document per chat. The access pattern is
-- strictly whole-record get/set keyed by chat id (every setter
-- rewrites the chat's small settings object; no field is ever queried
-- independently in SQL), so per-field columns would buy nothing.
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id  TEXT PRIMARY KEY,
  settings TEXT NOT NULL
);

-- Media index: lookups filter by chat, by chat+type, order by
-- timestamp, and the expiry sweep scans by timestamp alone — each
-- pattern gets an index. (chat_id, msg_id) is the natural key, so
-- upserts dedupe re-downloads of the same message in place.
CREATE TABLE IF NOT EXISTS media_index (
  chat_id      TEXT    NOT NULL,
  msg_id       INTEGER NOT NULL,
  sender_name  TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  file_path    TEXT    NOT NULL,
  caption      TEXT,
  timestamp    INTEGER NOT NULL,
  -- BLAKE3 content hash (native/blake3-wasm), filled in asynchronously
  -- after download; NULL until hashed. Backs the dedupe lookup and the
  -- reference count that keeps the expiry sweep from unlinking a file
  -- that deduped entries still share. Databases that shipped before
  -- this column get it via the reconcile ALTER in db.ts (sql/db.sql).
  content_hash TEXT,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_media_chat_time ON media_index(chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_media_chat_type_time ON media_index(chat_id, type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_media_time ON media_index(timestamp);
CREATE INDEX IF NOT EXISTS idx_media_hash ON media_index(content_hash);

-- Persistent goals: multi-turn objectives the agent commits to and
-- the heartbeat advances. Hot reads are filtered (per-chat listing
-- for the goal tools, cross-chat open scan for the heartbeat) and
-- ordered by recency, so each gets an index. Progress is a single
-- rolling note + timestamp rather than a journal table — the full
-- history already lands in heartbeat / chat logs.
CREATE TABLE IF NOT EXISTS goals (
  id                 TEXT    PRIMARY KEY,
  chat_id            TEXT    NOT NULL,
  title              TEXT    NOT NULL,
  description        TEXT,
  status             TEXT    NOT NULL DEFAULT 'active',
  priority           TEXT    NOT NULL DEFAULT 'normal',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  due_at             INTEGER,
  last_progress_note TEXT,
  last_progress_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goals_chat_status ON goals(chat_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status, updated_at DESC);

-- Agent-authored scripts. Metadata rows only: the script body lives on
-- disk under ~/.talon/workspace/scripts/ (mirroring the triggers store
-- split) so the agent can also Read/Edit a script as a normal workspace
-- file. Scripts are global capabilities, not chat data — no chat_id
-- column. \`name\` is the lookup key; UNIQUE enforces one per name.
CREATE TABLE IF NOT EXISTS scripts (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  description  TEXT    NOT NULL,
  language     TEXT    NOT NULL,
  script_path  TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);

-- Cron jobs: scheduled messages/queries per chat. Typed columns for
-- every field — the scheduler scans all jobs each tick and the
-- frontends list per chat, so rows must be cheap to read whole. A job
-- carries EITHER schedule (cron expression) OR every_ms (fixed
-- interval), never both — enforced by the store validator, not DDL,
-- so a legacy import can surface the row for repair instead of
-- silently dropping it.
CREATE TABLE IF NOT EXISTS cron_jobs (
  id               TEXT    PRIMARY KEY,
  chat_id          TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  type             TEXT    NOT NULL,
  content          TEXT    NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  schedule         TEXT,
  every_ms         INTEGER,
  timezone         TEXT,
  model            TEXT,
  provider         TEXT,
  instructions     TEXT,
  start_at         INTEGER,
  end_at           INTEGER,
  max_runs         INTEGER,
  catchup          TEXT,
  created_at       INTEGER NOT NULL,
  last_run_at      INTEGER,
  run_count        INTEGER NOT NULL DEFAULT 0,
  last_status      TEXT,
  last_error       TEXT,
  last_duration_ms INTEGER,
  timeout_ms       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cron_chat ON cron_jobs(chat_id);

-- Triggers: bot-authored watch scripts running as supervised
-- subprocesses. Script bodies + run logs stay on disk under
-- data/trigger-runs/ (same metadata/body split as scripts); this table
-- is the supervision state. Restart recovery flips interrupted rows in
-- place (see triggers-repo.ts), so status is a hot filter per chat.
CREATE TABLE IF NOT EXISTS triggers (
  id                TEXT    PRIMARY KEY,
  chat_id           TEXT    NOT NULL,
  numeric_chat_id   INTEGER NOT NULL,
  name              TEXT    NOT NULL,
  language          TEXT    NOT NULL,
  script_path       TEXT    NOT NULL,
  log_path          TEXT    NOT NULL,
  description       TEXT,
  status            TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  pid               INTEGER,
  pid_starttime     INTEGER,
  timeout_seconds   INTEGER NOT NULL,
  exit_code         INTEGER,
  fire_count        INTEGER NOT NULL DEFAULT 0,
  last_fire_at      INTEGER,
  last_fire_payload TEXT,
  last_error        TEXT,
  persistent        INTEGER NOT NULL DEFAULT 0,
  model             TEXT
);
CREATE INDEX IF NOT EXISTS idx_triggers_chat ON triggers(chat_id, status);

-- Small singleton state (heartbeat/dream run state, learned model
-- incompatibilities): namespaced key → JSON document. The shapes are
-- tiny, unqueried, and owned by their modules — a typed table per
-- blob would be schema churn for nothing. See storage/kv.ts.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Native-frontend turn metadata (tool calls, duration, token usage)
-- keyed by chat + message id, so the companion app's tool timeline
-- survives a history reload or daemon restart. Presentation metadata
-- with a per-chat retention window — one JSON document per turn, same
-- rationale as chat_settings.
CREATE TABLE IF NOT EXISTS turn_meta (
  chat_id TEXT NOT NULL,
  msg_id  TEXT NOT NULL,
  meta    TEXT NOT NULL,
  PRIMARY KEY (chat_id, msg_id)
);

-- The event journal: the bus's durable tail. A bootstrap subscriber
-- appends every published event (one JSON document per row, with the
-- type and timestamp lifted into columns for filtering) and prunes to a
-- bounded retention — so \`talon events --history\` and \`talon ps --all\`
-- can answer across daemon restarts. The in-memory ring in core/bus
-- stays the live-tail surface; this is the daemon's syslog. \`seq\` is
-- the durable cursor (per-process bus ids restart with the daemon).
CREATE TABLE IF NOT EXISTS journal (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  type    TEXT    NOT NULL,
  payload TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_type ON journal(type, seq);

-- WhatsApp message keys: Talon's numeric message id ↔ WhatsApp's
-- (id, remoteJid, fromMe, participant) key, plus the full proto as JSON
-- so react/reply/forward/download keep working on messages from before
-- a restart and media past the CDN TTL can be re-requested.
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  chat_id TEXT NOT NULL,
  msg_id INTEGER NOT NULL,
  wa_id TEXT NOT NULL,
  remote_jid TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  participant TEXT,
  sender_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  timestamp INTEGER NOT NULL,
  message_json TEXT,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_msg ON whatsapp_messages(msg_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_wa_id ON whatsapp_messages(wa_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_time ON whatsapp_messages(timestamp);

-- Snapshot index: the listing/status view over ~/.talon/backups/. The
-- manifest.json next to the parts on disk stays the source of truth for
-- a restore (a database that needs restoring cannot also be the record
-- of how), so these rows are a cache — dropped rows are re-derived from
-- the directories on the next boot, and a row whose directory is gone is
-- kept because the snapshot may still exist on a remote target.
CREATE TABLE IF NOT EXISTS backups (
  id            TEXT PRIMARY KEY,
  kind          TEXT    NOT NULL,
  label         TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at DESC);

-- Per-target upload state for one snapshot. Separate from the manifest
-- copy so retention can ask "what is on Drive?" without opening a file
-- per snapshot, and so a failed upload's error survives a restart.
CREATE TABLE IF NOT EXISTS backup_remotes (
  backup_id   TEXT    NOT NULL,
  target_id   TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  remote_id   TEXT,
  uploaded_at INTEGER,
  error       TEXT,
  PRIMARY KEY (backup_id, target_id)
);

-- Sub-agents a graceful shutdown (/restart, /update, SIGTERM) cut off
-- mid-run, waiting for the next daemon to resume them under the same
-- id. Rows are written at the start of shutdown and claimed — read and
-- deleted in one transaction — at boot, so each row is resumed at most
-- once; a crash-looping successor can never replay it. \`spec\` is the
-- JSON run spec (brief, parent, backend/model/effort, timeout, inbox);
-- see storage/suspended-agents.ts.
CREATE TABLE IF NOT EXISTS suspended_agents (
  id           TEXT    PRIMARY KEY,
  depth        INTEGER NOT NULL,
  suspended_at INTEGER NOT NULL,
  spec         TEXT    NOT NULL
);`;

export const backupsSql = {
  upsert: `INSERT OR REPLACE INTO backups
  (id, kind, label, pinned, created_at, size_bytes, manifest_json)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
  get: `SELECT id, kind, label, pinned, created_at, size_bytes, manifest_json
FROM backups WHERE id = ?`,
  all: `SELECT id, kind, label, pinned, created_at, size_bytes, manifest_json
FROM backups ORDER BY created_at DESC`,
  ids: `SELECT id FROM backups`,
  setPinned: `UPDATE backups SET pinned = ? WHERE id = ?`,
  setManifest: `UPDATE backups SET manifest_json = ?, pinned = ?, size_bytes = ? WHERE id = ?`,
  remove: `DELETE FROM backups WHERE id = ?`,
  upsertRemote: `INSERT OR REPLACE INTO backup_remotes
  (backup_id, target_id, status, remote_id, uploaded_at, error)
VALUES (?, ?, ?, ?, ?, ?)`,
  remotesAll: `SELECT backup_id, target_id, status, remote_id, uploaded_at, error
FROM backup_remotes`,
  remotesFor: `SELECT backup_id, target_id, status, remote_id, uploaded_at, error
FROM backup_remotes WHERE backup_id = ?`,
  removeRemotes: `DELETE FROM backup_remotes WHERE backup_id = ?`,
  removeRemote: `DELETE FROM backup_remotes WHERE backup_id = ? AND target_id = ?`,
} as const;

export const chatSettingsSql = {
  upsert: `INSERT OR REPLACE INTO chat_settings (chat_id, settings) VALUES (?, ?)`,
  all: `SELECT chat_id, settings FROM chat_settings`,
  remove: `DELETE FROM chat_settings WHERE chat_id = ?`,
} as const;

export const cronSql = {
  upsert: `INSERT OR REPLACE INTO cron_jobs
  (id, chat_id, name, type, content, enabled, schedule, every_ms,
   timezone, model, provider, instructions, start_at, end_at, max_runs,
   catchup, created_at, last_run_at, run_count, last_status, last_error,
   last_duration_ms, timeout_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  get: `SELECT id, chat_id, name, type, content, enabled, schedule, every_ms,
       timezone, model, provider, instructions, start_at, end_at, max_runs,
       catchup, created_at, last_run_at, run_count, last_status, last_error,
       last_duration_ms, timeout_ms
FROM cron_jobs WHERE id = ?`,
  listByChat: `SELECT id, chat_id, name, type, content, enabled, schedule, every_ms,
       timezone, model, provider, instructions, start_at, end_at, max_runs,
       catchup, created_at, last_run_at, run_count, last_status, last_error,
       last_duration_ms, timeout_ms
FROM cron_jobs WHERE chat_id = ? ORDER BY created_at`,
  listAll: `SELECT id, chat_id, name, type, content, enabled, schedule, every_ms,
       timezone, model, provider, instructions, start_at, end_at, max_runs,
       catchup, created_at, last_run_at, run_count, last_status, last_error,
       last_duration_ms, timeout_ms
FROM cron_jobs ORDER BY created_at`,
  remove: `DELETE FROM cron_jobs WHERE id = ?`,
  count: `SELECT COUNT(*) AS n FROM cron_jobs`,
  removeAll: `DELETE FROM cron_jobs`,
} as const;

export const dbSql = {
  walCheckpoint: `PRAGMA wal_checkpoint(TRUNCATE)`,
  addMediaContentHashColumn: `-- Column reconciliation for databases that shipped before
-- content_hash existed: ALTER has no IF NOT EXISTS form, so db.ts
-- attempts this on every open and swallows "duplicate column name" /
-- "no such table" (fresh databases get the column via schema.sql).
ALTER TABLE media_index ADD COLUMN content_hash TEXT`,
  addHistorySenderHandleColumn: `-- Column reconciliation for databases that shipped before sender handles
-- were recorded. Fresh databases get the column via schema.sql.
ALTER TABLE history_messages ADD COLUMN sender_handle TEXT`,
  addSessionsMetricsColumn: `-- Column reconciliation for databases that shipped before per-session
-- metrics existed. Fresh databases get the column via schema.sql.
ALTER TABLE sessions ADD COLUMN metrics TEXT NOT NULL DEFAULT '{"lifetime":{"counters":{"queries":0,"toolCalls":0,"turnsWithTools":0,"apiCalls":0,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"failedTurns":0,"flowViolationRetries":0,"flowViolationCapExhausted":0,"trailingTextDropped":0},"latency":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"toolCallsByName":{},"backend":{},"cacheHitPercent":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"toolCallsPerTurn":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"apiCallsPerTurn":{"count":0,"sumMs":0,"minMs":null,"maxMs":0}},"buckets":{}}'`,
  addHistoryAttachmentsColumn: `-- Column reconciliation for databases that shipped before a message could
-- carry more than one attachment. Fresh databases get the column via
-- schema.sql.
ALTER TABLE history_messages ADD COLUMN attachments TEXT`,
  addSessionsLastTurnEndedAtColumn: `-- Column reconciliation for databases that shipped before the cache-age
-- signal existed. Fresh databases get the column via schema.sql.
ALTER TABLE sessions ADD COLUMN last_turn_ended_at INTEGER`,
  addCronTimeoutMsColumn: `-- Column reconciliation for databases that shipped before a cron job could
-- carry its own run timeout. Fresh databases get the column via schema.sql.
ALTER TABLE cron_jobs ADD COLUMN timeout_ms INTEGER`,
  vacuumInto: `-- Transactionally consistent copy of the whole database into a new file,
-- produced by SQLite itself (storage/db.ts snapshotDatabase). A backup
-- must never copy a live .db byte-wise: the WAL holds committed pages the
-- main file does not, so the copy would be a corrupt database or an old
-- one. Verified to accept a bound path on node:sqlite and bun:sqlite.
VACUUM INTO ?`,
} as const;

export const goalsSql = {
  upsert: `INSERT OR REPLACE INTO goals
  (id, chat_id, title, description, status, priority, created_at,
   updated_at, due_at, last_progress_note, last_progress_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  get: `SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals WHERE id = ?`,
  listByChat: `SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals WHERE chat_id = ? ORDER BY updated_at DESC`,
  listByChatAndStatus: `SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals
WHERE chat_id = ? AND status IN (/* statuses */)
ORDER BY updated_at DESC`,
  listByStatus: `SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals
WHERE status IN (/* statuses */)
ORDER BY updated_at DESC`,
  countByChatAndStatus: `SELECT COUNT(*) AS n FROM goals
WHERE chat_id = ? AND status IN (/* statuses */)`,
  remove: `DELETE FROM goals WHERE id = ?`,
} as const;

export const historySql = {
  insert: `INSERT OR IGNORE INTO history_messages
  (chat_id, msg_id, sender_id, sender_name, sender_handle, text,
   reply_to_msg_id, timestamp, media_type, sticker_file_id, file_path,
   attachments)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  recent: `SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? ORDER BY id DESC LIMIT ?`,
  recentBefore: `-- Scroll-back pagination: the window of messages strictly older than a
-- given msg_id, newest-first (the repository reverses to chronological).
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND msg_id < ? ORDER BY id DESC LIMIT ?`,
  recentBeforeTime: `-- Time-cursor variant of recentBefore for the read_history \`before\` date
-- parameter: the newest \`limit\` messages strictly older than a timestamp.
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND timestamp < ? ORDER BY id DESC LIMIT ?`,
  setFilePath: `UPDATE history_messages SET file_path = ? WHERE chat_id = ? AND msg_id = ?`,
  deleteChat: `DELETE FROM history_messages WHERE chat_id = ?`,
  searchFts: `-- The match param must already be a valid FTS5 expression
-- (see history.ts ftsQuery).
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ?
  AND id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)
ORDER BY id DESC LIMIT ?`,
  searchFtsBetween: `-- searchFts restricted to a timestamp window [after, before) — the
-- search_history \`after\` / \`before\` date parameters. Either bound may be
-- the open end of the range (0 / a far-future value).
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ?
  AND id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)
  AND timestamp >= ? AND timestamp < ?
ORDER BY id DESC LIMIT ?`,
  bySenderName: `-- The fragment param is LIKE-escaped by the repository (backslash escape).
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND lower(sender_name) LIKE ? ESCAPE '\\'
ORDER BY id DESC LIMIT ?`,
  byMsgId: `SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND msg_id = ? ORDER BY id DESC LIMIT 1`,
  bySenderId: `SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT ?`,
  latestMsgId: `SELECT msg_id FROM history_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
  maxMsgIdForPrefix: `-- Highest msg_id across every chat whose id starts with a prefix
-- (parameter is a LIKE pattern with \\ escapes). Seeds the WhatsApp
-- frontend's in-memory id counter past what history already holds.
SELECT MAX(msg_id) AS max_id FROM history_messages WHERE chat_id LIKE ? ESCAPE '\\'`,
  knownUsers: `SELECT sender_id,
       MAX(timestamp) AS last_seen,
       COUNT(*) AS message_count,
       (SELECT sender_name FROM history_messages i
        WHERE i.chat_id = o.chat_id AND i.sender_id = o.sender_id
        ORDER BY i.id DESC LIMIT 1) AS name,
       -- Most recent NON-NULL handle: people set a username long after
       -- their first message, and the newest row may predate it.
       (SELECT i.sender_handle FROM history_messages i
        WHERE i.chat_id = o.chat_id AND i.sender_id = o.sender_id
          AND i.sender_handle IS NOT NULL
        ORDER BY i.id DESC LIMIT 1) AS handle
FROM history_messages o
WHERE chat_id = ?
GROUP BY sender_id
ORDER BY last_seen DESC`,
  statsByChat: `SELECT COUNT(*) AS total,
       COUNT(DISTINCT sender_id) AS users,
       COALESCE(MIN(timestamp), 0) AS oldest,
       COALESCE(MAX(timestamp), 0) AS newest
FROM history_messages WHERE chat_id = ?`,
  distinctChatCount: `SELECT COUNT(DISTINCT chat_id) AS chats FROM history_messages`,
} as const;

export const journalSql = {
  append: `INSERT INTO journal (at, type, payload) VALUES (?, ?, ?)`,
  recent: `SELECT seq, at, type, payload FROM journal ORDER BY seq DESC LIMIT ?`,
  recentByType: `SELECT seq, at, type, payload FROM journal WHERE type = ? ORDER BY seq DESC LIMIT ?`,
  prune: `DELETE FROM journal WHERE seq NOT IN (SELECT seq FROM journal ORDER BY seq DESC LIMIT ?)`,
  count: `SELECT COUNT(*) AS n FROM journal`,
} as const;

export const kvSql = {
  get: `SELECT value FROM kv WHERE key = ?`,
  set: `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  remove: `DELETE FROM kv WHERE key = ?`,
} as const;

export const mediaIndexSql = {
  upsert: `INSERT OR REPLACE INTO media_index
  (chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  recentByChat: `-- Ties on timestamp keep insertion order (rowid ASC) to match the
-- legacy stable sort.
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index
WHERE chat_id = ? ORDER BY timestamp DESC, rowid ASC LIMIT ?`,
  byType: `SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index
WHERE chat_id = ? AND type = ?
ORDER BY timestamp DESC, rowid ASC LIMIT ?`,
  olderThan: `SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index WHERE timestamp < ?`,
  deleteOlderThan: `DELETE FROM media_index WHERE timestamp < ?`,
  setContentHash: `UPDATE media_index SET content_hash = ? WHERE chat_id = ? AND msg_id = ?`,
  setFilePath: `UPDATE media_index SET file_path = ? WHERE chat_id = ? AND msg_id = ?`,
  firstByContentHash: `-- Oldest entry with this content hash other than the given row — the
-- canonical copy a duplicate download is deduped against.
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index
WHERE content_hash = ? AND NOT (chat_id = ? AND msg_id = ?)
ORDER BY timestamp ASC, rowid ASC LIMIT 1`,
  countByFilePath: `SELECT COUNT(*) AS n FROM media_index WHERE file_path = ?`,
} as const;

export const memorySql = {
  insert: `-- RETURNING id so the caller gets the new row id without a second
-- round trip through last_insert_rowid().
INSERT INTO memory
  (kind, subject, key, text, source_frontend, source_chat, source_actor,
   source_turn, trust, confidence, created_at, last_seen_at, hit_count,
   salience, pinned, superseded_by, dropped_at, content_hash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
RETURNING id`,
  get: `SELECT id, kind, subject, key, text, source_frontend, source_chat,
       source_actor, source_turn, trust, confidence, created_at,
       last_seen_at, hit_count, salience, pinned, superseded_by,
       dropped_at, content_hash
FROM memory WHERE id = ?`,
  list: `SELECT id, kind, subject, key, text, source_frontend, source_chat,
       source_actor, source_turn, trust, confidence, created_at,
       last_seen_at, hit_count, salience, pinned, superseded_by,
       dropped_at, content_hash
FROM memory
WHERE (? IS NULL OR kind = ?)
  AND (? IS NULL OR subject = ?)
  AND (? = 1 OR superseded_by IS NULL)
  AND (? = 1 OR dropped_at IS NULL)
ORDER BY pinned DESC, salience DESC, last_seen_at DESC, id DESC
LIMIT ?`,
  liveStateByKey: `SELECT id, kind, subject, key, text, source_frontend, source_chat,
       source_actor, source_turn, trust, confidence, created_at,
       last_seen_at, hit_count, salience, pinned, superseded_by,
       dropped_at, content_hash
FROM memory
WHERE kind = 'state' AND key = ?
  AND superseded_by IS NULL AND dropped_at IS NULL
ORDER BY id DESC LIMIT 1`,
  searchFts: `-- The match param must already be a valid FTS5 expression
-- (see memory.ts ftsQuery). Live rows only, best match first.
SELECT m.id, m.kind, m.subject, m.key, m.text, m.source_frontend,
       m.source_chat, m.source_actor, m.source_turn, m.trust, m.confidence,
       m.created_at, m.last_seen_at, m.hit_count, m.salience, m.pinned,
       m.superseded_by, m.dropped_at, m.content_hash
FROM memory m JOIN memory_fts ON memory_fts.rowid = m.id
WHERE memory_fts MATCH ?
  AND m.superseded_by IS NULL AND m.dropped_at IS NULL
  AND (? IS NULL OR m.kind = ?)
ORDER BY bm25(memory_fts) LIMIT ?`,
  similar: `-- Near-duplicate candidates for a fresh assert: live rows of the same
-- kind + subject that match the new text, the new row itself excluded.
SELECT m.id, m.kind, m.subject, m.key, m.text, m.source_frontend,
       m.source_chat, m.source_actor, m.source_turn, m.trust, m.confidence,
       m.created_at, m.last_seen_at, m.hit_count, m.salience, m.pinned,
       m.superseded_by, m.dropped_at, m.content_hash
FROM memory m JOIN memory_fts ON memory_fts.rowid = m.id
WHERE memory_fts MATCH ?
  AND m.kind = ? AND m.subject = ? AND m.id <> ?
  AND m.superseded_by IS NULL AND m.dropped_at IS NULL
ORDER BY bm25(memory_fts) LIMIT ?`,
  setSupersededBy: `UPDATE memory SET superseded_by = ? WHERE id = ?`,
  setDropped: `UPDATE memory SET dropped_at = ? WHERE id = ?`,
  setPinned: `UPDATE memory SET pinned = ? WHERE id = ?`,
  touch: `UPDATE memory SET hit_count = hit_count + 1, last_seen_at = ? WHERE id = ?`,
  insertHistory: `INSERT INTO memory_history (memory_id, op, before_text, after_text, reason, at)
VALUES (?, ?, ?, ?, ?, ?)`,
  historyFor: `SELECT id, memory_id, op, before_text, after_text, reason, at
FROM memory_history WHERE memory_id = ? ORDER BY id`,
} as const;

export const scriptsSql = {
  upsert: `INSERT OR REPLACE INTO scripts
  (id, name, description, language, script_path, created_at,
   updated_at, use_count, last_used_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  getByName: `SELECT id, name, description, language, script_path, created_at,
       updated_at, use_count, last_used_at
FROM scripts WHERE name = ?`,
  all: `SELECT id, name, description, language, script_path, created_at,
       updated_at, use_count, last_used_at
FROM scripts
ORDER BY last_used_at DESC NULLS LAST, updated_at DESC`,
  count: `SELECT COUNT(*) AS n FROM scripts`,
  recordUse: `UPDATE scripts SET use_count = use_count + 1, last_used_at = ? WHERE name = ?`,
  removeByName: `DELETE FROM scripts WHERE name = ?`,
} as const;

export const sessionsSql = {
  upsert: `INSERT OR REPLACE INTO sessions
  (chat_id, session_id, session_name, last_model, turns, last_active,
   created_at, last_bot_message_id, total_input_tokens, total_output_tokens,
   total_cache_read, total_cache_write, last_prompt_tokens, context_tokens,
   context_window, num_api_calls, estimated_cost_usd, total_response_ms,
   last_response_ms, fastest_response_ms, last_turn_ended_at, metrics)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  all: `SELECT chat_id, session_id, session_name, last_model, turns, last_active,
       created_at, last_bot_message_id, total_input_tokens, total_output_tokens,
       total_cache_read, total_cache_write, last_prompt_tokens, context_tokens,
       context_window, num_api_calls, estimated_cost_usd, total_response_ms,
       last_response_ms, fastest_response_ms, last_turn_ended_at, metrics
FROM sessions`,
  remove: `DELETE FROM sessions WHERE chat_id = ?`,
} as const;

export const suspendedAgentsSql = {
  upsert: `INSERT INTO suspended_agents (id, depth, suspended_at, spec) VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET depth = excluded.depth,
  suspended_at = excluded.suspended_at, spec = excluded.spec`,
  listAll: `SELECT id, depth, suspended_at, spec FROM suspended_agents
ORDER BY depth ASC, suspended_at ASC, id ASC`,
  removeAll: `DELETE FROM suspended_agents`,
} as const;

export const triggersSql = {
  upsert: `INSERT OR REPLACE INTO triggers
  (id, chat_id, numeric_chat_id, name, language, script_path, log_path,
   description, status, created_at, started_at, ended_at, pid,
   pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
   last_fire_payload, last_error, persistent, model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  get: `SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model
FROM triggers WHERE id = ?`,
  getByName: `SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model
FROM triggers WHERE chat_id = ? AND name = ? LIMIT 1`,
  listByChat: `SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model
FROM triggers WHERE chat_id = ? ORDER BY created_at`,
  listAll: `SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model
FROM triggers ORDER BY created_at`,
  remove: `DELETE FROM triggers WHERE id = ?`,
  count: `SELECT COUNT(*) AS n FROM triggers`,
  removeAll: `DELETE FROM triggers

-- Restart recovery (see loadTriggers): a non-persistent trigger that was
-- alive when the previous process died is dead now — mark it terminated
-- so the bot gets a wake fire about what happened. COALESCE keeps any
-- endedAt/lastError a clean shutdown already recorded.`,
  terminateInterrupted: `UPDATE triggers
SET status = 'terminated',
    pid = NULL,
    ended_at = COALESCE(ended_at, ?),
    -- Literal must match RESTART_KILL_ERROR in storage/triggers.ts.
    last_error = COALESCE(last_error, 'Talon restarted while trigger was running')
WHERE status IN ('running', 'pending') AND persistent = 0

-- Persistent triggers park in 'pending' with their pid preserved so
-- resumeAfterRestart can probe for a surviving orphan before respawning.`,
  parkInterruptedPersistent: `UPDATE triggers
SET status = 'pending'
WHERE status IN ('running', 'pending') AND persistent = 1`,
} as const;

export const turnMetaSql = {
  get: `SELECT meta FROM turn_meta WHERE chat_id = ? AND msg_id = ?`,
  upsert: `INSERT OR REPLACE INTO turn_meta (chat_id, msg_id, meta) VALUES (?, ?, ?)`,
  removeChat: `DELETE FROM turn_meta WHERE chat_id = ?

-- Retention: keep only the newest N turns per chat, matching the
-- /history page ceiling. Message ids are numeric-ascending per chat,
-- compared as integers.`,
  prune: `DELETE FROM turn_meta
WHERE chat_id = ?1
  AND msg_id NOT IN (
    SELECT msg_id FROM turn_meta
    WHERE chat_id = ?1
    ORDER BY CAST(msg_id AS INTEGER) DESC
    LIMIT ?2
  )`,
} as const;

export const whatsappMessagesSql = {
  insert: `INSERT OR IGNORE INTO whatsapp_messages
  (chat_id, msg_id, wa_id, remote_jid, from_me, participant, sender_name,
   text, timestamp, message_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  byMsgId: `SELECT chat_id, msg_id, wa_id, remote_jid, from_me, participant, sender_name,
       text, timestamp, message_json
FROM whatsapp_messages WHERE msg_id = ? LIMIT 1`,
  byWaId: `-- Newest first: a WhatsApp id re-delivered on reconnect maps to the row
-- that already exists for it.
SELECT chat_id, msg_id, wa_id, remote_jid, from_me, participant, sender_name,
       text, timestamp, message_json
FROM whatsapp_messages WHERE wa_id = ? ORDER BY msg_id DESC LIMIT 1`,
  maxMsgId: `SELECT MAX(msg_id) AS max_id FROM whatsapp_messages`,
  deleteOlderThan: `DELETE FROM whatsapp_messages WHERE timestamp < ?`,
  deleteAll: `DELETE FROM whatsapp_messages`,
} as const;
