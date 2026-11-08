/**
 * Telegram message handlers.
 *
 * Split by responsibility:
 *   - `state`    — shared module-level maps/sets (access config, queues,
 *                  rate-limit windows, caches)
 *   - `access`   — DM whitelist + group admin checks, unauthorized handling
 *   - `context`  — sender/reply/forward context strings + file downloads
 *   - `delivery` — HTML send, streaming drafts, the agent run pipeline
 *   - `queue`    — per-chat debounce queue + per-user rate limiting
 *   - `messages` — per-message-type handlers (text/photo/voice/…/callback)
 */

export {
  setAccessControl,
  shouldHandleInGroup,
  extractUnauthorizedPreview,
  registerCommandAccessGate,
} from "./access.js";
export {
  getSenderName,
  getReplyContext,
  getForwardContext,
} from "./context.js";
export { buildGroupGapContextNotice } from "./queue.js";
export {
  handleTextMessage,
  handlePhotoMessage,
  handleDocumentMessage,
  handleVoiceMessage,
  handleStickerMessage,
  handleVideoMessage,
  handleAnimationMessage,
  handleAudioMessage,
  handleVideoNoteMessage,
  handleCallbackQuery,
} from "./messages.js";
