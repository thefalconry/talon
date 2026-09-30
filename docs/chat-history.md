# Chat history

Talon stores every chat message it sees in `history_messages`
(`~/.talon/data/talon.db`, with an FTS5 index). **Nothing in normal
operation deletes those rows.**

| Event                                                  | Backend session        | History rows              | Bot context                  |
| ------------------------------------------------------ | ---------------------- | ------------------------- | ---------------------------- |
| Backend or model switch (any frontend)                 | reset, old id archived | untouched                 | unchanged                    |
| `/reset`, `/new`, `/admin kill`, native chat reset     | reset, old id archived | kept                      | starts fresh (soft reset)    |
| Deleting a chat in the companion app                   | deleted                | kept, chat flagged hidden | starts fresh if it reappears |
| `talon history purge <chat>` (operator, host CLI only) | —                      | **deleted**               | —                            |

## Soft reset

A reset records a per-chat marker in `history_chat_state`
(`cleared_through_id`: the newest history row at reset time). Readers
decide per purpose whether they start after it:

| Reader                                                                        | Respects the marker?                                   | Why                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `getRecentHistory` (pulse unread scan, group-gap notice, terminal `/context`) | yes                                                    | these feed the bot's current context                                       |
| `read_history` / `read_chat_history` tool (shared handler)                    | yes, and says older messages exist                     | a history tool should start fresh after a reset, but point at the way back |
| `search_history` / `get_user_messages` tools (shared handler)                 | no — older rows labelled `[before context reset]`      | explicit search is how a reset conversation is recovered                   |
| `getMessageById` (reply lookups)                                              | no                                                     | an explicit id is an explicit ask                                          |
| `list_known_users`, `talon history show`, stats                               | no                                                     | counts about the chat, not its context                                     |
| Native transcript (`/history` page + scroll-back, chat preview)               | yes                                                    | the app shows the conversation fresh after a reset, as before              |
| Native search                                                                 | no (unlabelled — the wire message has no field for it) | recovery path in the app                                                   |
| Telegram userbot / Discord platform history                                   | n/a                                                    | read from the platform, not from Talon's store                             |

## Purge

`talon history purge <chatId>` deletes a chat's rows, its state and its
turn meta. It asks for the chat id to be typed back (or `--yes`), and it
is not reachable from any chat surface. Take a checkpoint first:
`talon backup now --checkpoint "before purge"`.

`talon history hidden` lists chats deleted in the app (their rows are
kept); `talon history show <chatId>` prints a chat's counts and state.
