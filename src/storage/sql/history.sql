-- Statements for the history tables (see repositories/history-repo.ts
-- for the parameter order and row↔domain mapping).

-- name: insert
INSERT OR IGNORE INTO history_messages
  (chat_id, msg_id, sender_id, sender_name, sender_handle, text,
   reply_to_msg_id, timestamp, media_type, sticker_file_id, file_path,
   attachments)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

-- name: recent
-- The `id > ?` floor is the chat's context-reset marker (0 for none; see
-- chatState below): rows at or under it stay stored and searchable but
-- are no longer the chat's current conversation.
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND id > ? ORDER BY id DESC LIMIT ?

-- name: recentBefore
-- Scroll-back pagination: the window of messages strictly older than a
-- given msg_id, newest-first (the repository reverses to chronological).
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND msg_id < ? AND id > ? ORDER BY id DESC LIMIT ?

-- name: recentBeforeTime
-- Time-cursor variant of recentBefore for the read_history `before` date
-- parameter: the newest `limit` messages strictly older than a timestamp.
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND timestamp < ? AND id > ? ORDER BY id DESC LIMIT ?

-- name: setFilePath
UPDATE history_messages SET file_path = ? WHERE chat_id = ? AND msg_id = ?

-- name: purgeChat
-- The ONLY statement that deletes history rows. Reached solely through the
-- operator's explicit `talon history purge` (history.ts purgeChatHistory);
-- resets, backend switches and chat deletion never delete rows.
DELETE FROM history_messages WHERE chat_id = ?

-- name: purgeChatState
DELETE FROM history_chat_state WHERE chat_id = ?

-- name: chatState
SELECT cleared_through_id, cleared_at, hidden_at
FROM history_chat_state WHERE chat_id = ?

-- name: markCleared
-- Soft reset: move the chat's context floor to its newest stored row. The
-- rows stay; readers that build the bot's context skip everything at or
-- under the floor. Parameters: chat_id, chat_id, cleared_at.
INSERT INTO history_chat_state (chat_id, cleared_through_id, cleared_at)
VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM history_messages WHERE chat_id = ?), ?)
ON CONFLICT(chat_id) DO UPDATE SET
  cleared_through_id = excluded.cleared_through_id,
  cleared_at = excluded.cleared_at

-- name: markHidden
-- Soft delete: a chat the user deleted is hidden (and its context floor
-- moved, so a chat that reappears under the same id starts fresh). The
-- rows stay. Parameters: chat_id, chat_id, cleared_at, hidden_at.
INSERT INTO history_chat_state (chat_id, cleared_through_id, cleared_at, hidden_at)
VALUES (?, (SELECT COALESCE(MAX(id), 0) FROM history_messages WHERE chat_id = ?), ?, ?)
ON CONFLICT(chat_id) DO UPDATE SET
  cleared_through_id = excluded.cleared_through_id,
  cleared_at = excluded.cleared_at,
  hidden_at = excluded.hidden_at

-- name: hiddenChats
SELECT s.chat_id, s.hidden_at,
       (SELECT COUNT(*) FROM history_messages h WHERE h.chat_id = s.chat_id) AS total
FROM history_chat_state s
WHERE s.hidden_at IS NOT NULL
ORDER BY s.hidden_at DESC

-- name: searchFts
-- The match param must already be a valid FTS5 expression
-- (see history.ts ftsQuery).
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ?
  AND id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)
ORDER BY id DESC LIMIT ?

-- name: searchFtsBetween
-- searchFts restricted to a timestamp window [after, before) — the
-- search_history `after` / `before` date parameters. Either bound may be
-- the open end of the range (0 / a far-future value).
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ?
  AND id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)
  AND timestamp >= ? AND timestamp < ?
ORDER BY id DESC LIMIT ?

-- name: bySenderName
-- The fragment param is LIKE-escaped by the repository (backslash escape).
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND lower(sender_name) LIKE ? ESCAPE '\'
ORDER BY id DESC LIMIT ?

-- name: byMsgId
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND msg_id = ? ORDER BY id DESC LIMIT 1

-- name: bySenderId
SELECT msg_id, sender_id, sender_name, sender_handle, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path, attachments
FROM history_messages
WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT ?

-- name: latestMsgId
SELECT msg_id FROM history_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1

-- name: maxMsgIdForPrefix
-- Highest msg_id across every chat whose id starts with a prefix
-- (parameter is a LIKE pattern with \ escapes). Seeds the WhatsApp
-- frontend's in-memory id counter past what history already holds.
SELECT MAX(msg_id) AS max_id FROM history_messages WHERE chat_id LIKE ? ESCAPE '\'

-- name: knownUsers
SELECT sender_id,
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
ORDER BY last_seen DESC

-- name: statsByChat
SELECT COUNT(*) AS total,
       COUNT(DISTINCT sender_id) AS users,
       COALESCE(MIN(timestamp), 0) AS oldest,
       COALESCE(MAX(timestamp), 0) AS newest
FROM history_messages WHERE chat_id = ?

-- name: distinctChatCount
SELECT COUNT(DISTINCT chat_id) AS chats FROM history_messages
