-- Statements for the agents table (see storage/agents/repo.ts for
-- the parameter order and row↔domain mapping).

-- name: upsert
INSERT OR REPLACE INTO agents
  (id, label, brief, parent_kind, parent_id, parent_numeric, backend_id,
   model, requested_model, effort, timeout_ms, depth, cwd, state,
   created_at, started_at, ended_at, updated_at, session_id, inbox_json,
   reported, result_summary, result_details, error, elapsed_ms,
   resume_count, interrupted_at, preflight)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

-- name: get
SELECT id, label, brief, parent_kind, parent_id, parent_numeric, backend_id,
       model, requested_model, effort, timeout_ms, depth, cwd, state,
       created_at, started_at, ended_at, updated_at, session_id, inbox_json,
       reported, result_summary, result_details, error, elapsed_ms,
       resume_count, interrupted_at, preflight
FROM agents WHERE id = ?

-- Rows a restart interrupted, parents before children (a child can only
-- be re-attached to a parent that is already back in the registry).

-- name: listInterrupted
SELECT id, label, brief, parent_kind, parent_id, parent_numeric, backend_id,
       model, requested_model, effort, timeout_ms, depth, cwd, state,
       created_at, started_at, ended_at, updated_at, session_id, inbox_json,
       reported, result_summary, result_details, error, elapsed_ms,
       resume_count, interrupted_at, preflight
FROM agents WHERE state IN ('queued', 'running')
ORDER BY depth, created_at

-- name: remove
DELETE FROM agents WHERE id = ?

-- Retention: settled rows past their window. Live rows are never pruned.

-- name: pruneSettled
DELETE FROM agents
WHERE state NOT IN ('queued', 'running') AND updated_at < ?

-- name: removeAll
DELETE FROM agents
