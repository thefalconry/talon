-- Statements shared by every store.

-- name: walCheckpoint
PRAGMA wal_checkpoint(TRUNCATE)

-- name: addMediaContentHashColumn
-- Column reconciliation for databases that shipped before
-- content_hash existed: ALTER has no IF NOT EXISTS form, so db.ts
-- attempts this on every open and swallows "duplicate column name" /
-- "no such table" (fresh databases get the column via schema.sql).
ALTER TABLE media_index ADD COLUMN content_hash TEXT

-- name: addHistorySenderHandleColumn
-- Column reconciliation for databases that shipped before sender handles
-- were recorded. Fresh databases get the column via schema.sql.
ALTER TABLE history_messages ADD COLUMN sender_handle TEXT

-- name: addSessionsMetricsColumn
-- Column reconciliation for databases that shipped before per-session
-- metrics existed. Fresh databases get the column via schema.sql.
ALTER TABLE sessions ADD COLUMN metrics TEXT NOT NULL DEFAULT '{"lifetime":{"counters":{"queries":0,"toolCalls":0,"turnsWithTools":0,"apiCalls":0,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"failedTurns":0,"flowViolationRetries":0,"flowViolationCapExhausted":0,"trailingTextDropped":0},"latency":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"toolCallsByName":{},"backend":{},"cacheHitPercent":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"toolCallsPerTurn":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"apiCallsPerTurn":{"count":0,"sumMs":0,"minMs":null,"maxMs":0}},"buckets":{}}'

-- name: addHistoryAttachmentsColumn
-- Column reconciliation for databases that shipped before a message could
-- carry more than one attachment. Fresh databases get the column via
-- schema.sql.
ALTER TABLE history_messages ADD COLUMN attachments TEXT

-- name: addSessionsLastTurnEndedAtColumn
-- Column reconciliation for databases that shipped before the cache-age
-- signal existed. Fresh databases get the column via schema.sql.
ALTER TABLE sessions ADD COLUMN last_turn_ended_at INTEGER

-- name: addCronTimeoutMsColumn
-- Column reconciliation for databases that shipped before a cron job could
-- carry its own run timeout. Fresh databases get the column via schema.sql.
ALTER TABLE cron_jobs ADD COLUMN timeout_ms INTEGER

-- name: vacuumInto
-- Transactionally consistent copy of the whole database into a new file,
-- produced by SQLite itself (storage/db.ts snapshotDatabase). A backup
-- must never copy a live .db byte-wise: the WAL holds committed pages the
-- main file does not, so the copy would be a corrupt database or an old
-- one. Verified to accept a bound path on node:sqlite and bun:sqlite.
VACUUM INTO ?
