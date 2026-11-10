-- Statements for the triggers table (see repositories/triggers-repo.ts
-- for the parameter order and row↔domain mapping).

-- name: upsert
INSERT OR REPLACE INTO triggers
  (id, chat_id, numeric_chat_id, name, language, script_path, log_path,
   description, status, created_at, started_at, ended_at, pid,
   pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
   last_fire_payload, last_error, persistent, model, wake_mode,
   wake_instructions, wake_provider, wake_timeout_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?)

-- name: get
SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model, wake_mode,
       wake_instructions, wake_provider, wake_timeout_ms
FROM triggers WHERE id = ?

-- name: getByName
SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model, wake_mode,
       wake_instructions, wake_provider, wake_timeout_ms
FROM triggers WHERE chat_id = ? AND name = ? LIMIT 1

-- name: listByChat
SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model, wake_mode,
       wake_instructions, wake_provider, wake_timeout_ms
FROM triggers WHERE chat_id = ? ORDER BY created_at

-- name: listAll
SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model, wake_mode,
       wake_instructions, wake_provider, wake_timeout_ms
FROM triggers ORDER BY created_at

-- name: remove
DELETE FROM triggers WHERE id = ?

-- name: count
SELECT COUNT(*) AS n FROM triggers

-- name: removeAll
DELETE FROM triggers

-- Restart recovery (see loadTriggers): a non-persistent trigger that was
-- alive when the previous process died is dead now — mark it terminated
-- so the bot gets a wake fire about what happened. COALESCE keeps any
-- endedAt/lastError a clean shutdown already recorded.

-- name: terminateInterrupted
UPDATE triggers
SET status = 'terminated',
    pid = NULL,
    ended_at = COALESCE(ended_at, ?),
    -- Literal must match RESTART_KILL_ERROR in storage/triggers.ts.
    last_error = COALESCE(last_error, 'Talon restarted while trigger was running')
WHERE status IN ('running', 'pending') AND persistent = 0

-- Persistent triggers park in 'pending' with their pid preserved so
-- resumeAfterRestart can probe for a surviving orphan before respawning.

-- name: parkInterruptedPersistent
UPDATE triggers
SET status = 'pending'
WHERE status IN ('running', 'pending') AND persistent = 1
