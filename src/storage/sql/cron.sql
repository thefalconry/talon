-- Statements for the cron_jobs table (see repositories/cron-repo.ts
-- for the parameter order and row↔domain mapping).

-- name: upsert
INSERT OR REPLACE INTO cron_jobs
  (id, chat_id, name, type, content, enabled, schedule, every_ms,
   timezone, model, provider, instructions, start_at, end_at, max_runs,
   catchup, created_at, last_run_at, run_count, last_status, last_error,
   last_duration_ms, timeout_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

-- name: get
SELECT id, chat_id, name, type, content, enabled, schedule, every_ms,
       timezone, model, provider, instructions, start_at, end_at, max_runs,
       catchup, created_at, last_run_at, run_count, last_status, last_error,
       last_duration_ms, timeout_ms
FROM cron_jobs WHERE id = ?

-- name: listByChat
SELECT id, chat_id, name, type, content, enabled, schedule, every_ms,
       timezone, model, provider, instructions, start_at, end_at, max_runs,
       catchup, created_at, last_run_at, run_count, last_status, last_error,
       last_duration_ms, timeout_ms
FROM cron_jobs WHERE chat_id = ? ORDER BY created_at

-- name: listAll
SELECT id, chat_id, name, type, content, enabled, schedule, every_ms,
       timezone, model, provider, instructions, start_at, end_at, max_runs,
       catchup, created_at, last_run_at, run_count, last_status, last_error,
       last_duration_ms, timeout_ms
FROM cron_jobs ORDER BY created_at

-- name: remove
DELETE FROM cron_jobs WHERE id = ?

-- name: count
SELECT COUNT(*) AS n FROM cron_jobs

-- name: removeAll
DELETE FROM cron_jobs
