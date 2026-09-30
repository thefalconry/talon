-- Statements for the suspended_agents table (see storage/suspended-agents.ts).

-- name: upsert
INSERT INTO suspended_agents (id, depth, suspended_at, spec) VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET depth = excluded.depth,
  suspended_at = excluded.suspended_at, spec = excluded.spec

-- name: listAll
SELECT id, depth, suspended_at, spec FROM suspended_agents
ORDER BY depth ASC, suspended_at ASC, id ASC

-- name: removeAll
DELETE FROM suspended_agents
