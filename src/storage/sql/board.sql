-- Statements for the agent_board table (see storage/agents/board-repo.ts).

-- name: insert
INSERT INTO agent_board
  (chat_id, author_id, author_label, topic, kind, text, created_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)

-- Live entries of one chat tree, oldest first. Dead leases (released or
-- expired) are not live. Params: chat_id, now, since_id, topic-or-null, topic.

-- name: listLive
SELECT id, chat_id, author_id, author_label, topic, kind, text, created_at,
       expires_at
FROM agent_board
WHERE chat_id = ?
  AND id > ?
  AND (kind != 'lease' OR (released_at IS NULL AND expires_at > ?))
  AND (? IS NULL OR topic = ?)
ORDER BY id

-- name: findLiveLease
SELECT id, chat_id, author_id, author_label, topic, kind, text, created_at,
       expires_at
FROM agent_board
WHERE chat_id = ? AND kind = 'lease' AND topic = ?
  AND released_at IS NULL AND expires_at > ?
ORDER BY id DESC LIMIT 1

-- name: renewLease
UPDATE agent_board SET expires_at = ?, text = ? WHERE id = ?

-- name: releaseLease
UPDATE agent_board SET released_at = ?
WHERE chat_id = ? AND kind = 'lease' AND topic = ? AND author_id = ?
  AND released_at IS NULL AND expires_at > ?

-- name: releaseAllFor
UPDATE agent_board SET released_at = ?
WHERE author_id = ? AND kind = 'lease' AND released_at IS NULL

-- Dead leases are garbage; drop them with the cap sweep.

-- name: pruneDeadLeases
DELETE FROM agent_board
WHERE chat_id = ? AND kind = 'lease'
  AND (released_at IS NOT NULL OR expires_at <= ?)

-- name: countLive
SELECT COUNT(*) AS n FROM agent_board WHERE chat_id = ?

-- Oldest non-lease entries beyond the cap. Param: chat_id, then the number
-- of surplus rows.

-- name: dropOldestNonLease
DELETE FROM agent_board WHERE id IN (
  SELECT id FROM agent_board
  WHERE chat_id = ? AND kind != 'lease'
  ORDER BY id LIMIT ?
)

-- name: removeAll
DELETE FROM agent_board
