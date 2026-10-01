/**
 * Secrets — the ~/.talon/secrets folder and the drop links that fill it
 * without a password ever crossing a chat.
 */

export {
  isLiveSecretDrop,
  openSecretDropForm,
  secretCommandReply,
  submitSecretDrop,
} from "./service.js";
