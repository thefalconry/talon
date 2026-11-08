-- Statements for the media_index table (see
-- repositories/media-index-repo.ts for the parameter order and
-- row↔domain mapping).

-- name: upsert
INSERT OR REPLACE INTO media_index
  (chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)

-- name: recentByChat
-- Ties on timestamp keep insertion order (rowid ASC) to match the
-- legacy stable sort.
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index
WHERE chat_id = ? ORDER BY timestamp DESC, rowid ASC LIMIT ?

-- name: byType
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index
WHERE chat_id = ? AND type = ?
ORDER BY timestamp DESC, rowid ASC LIMIT ?

-- name: olderThan
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index WHERE timestamp < ?

-- name: deleteOlderThan
DELETE FROM media_index WHERE timestamp < ?

-- name: setContentHash
UPDATE media_index SET content_hash = ? WHERE chat_id = ? AND msg_id = ?

-- name: setFilePath
UPDATE media_index SET file_path = ? WHERE chat_id = ? AND msg_id = ?

-- name: firstByContentHash
-- Oldest entry with this content hash other than the given row — the
-- canonical copy a duplicate download is deduped against.
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index
WHERE content_hash = ? AND NOT (chat_id = ? AND msg_id = ?)
ORDER BY timestamp ASC, rowid ASC LIMIT 1

-- name: countByFilePath
SELECT COUNT(*) AS n FROM media_index WHERE file_path = ?

-- name: byMessage
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index WHERE chat_id = ? AND msg_id = ?
