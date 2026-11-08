/**
 * Discord message handlers — mirrors the telegram handlers/ layout.
 *
 *   - `state`    — shared maps/sets (chat registry, access config, queues,
 *                  rate-limit windows, cooldowns)
 *   - `registry` — numeric/string chatId → Discord channel info accessors
 *   - `access`   — DM/guild/channel allowlists, admin checks, mention gating,
 *                  unauthorized handling, rate limiting
 *   - `context`  — sender/reply context, attachment download/classify,
 *                  chunked send
 *   - `delivery` — the agent run + reply pipeline (processAndReply)
 *   - `queue`    — per-chat debounce queue
 *   - `messages` — the messageCreate handler (handleMessage)
 */

export { registerDiscordChat, lookupDiscordChat } from "./registry.js";
export { setAccessControl, isAdmin, isInteractionAllowed } from "./access.js";
export { getSenderName, sendChunked } from "./context.js";
export { handleMessage } from "./messages.js";
