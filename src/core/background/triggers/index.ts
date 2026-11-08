/**
 * Trigger supervisor — runs bot-authored scripts as long-running children
 * that signal back to fire wake-up messages into the originating chat.
 *
 * Split by responsibility:
 *   - `state`   — injected deps + the child/timeout/log/buffer registries,
 *                 the warden set, timing constants, init + getRunningCount
 *   - `caps`    — per-chat active-trigger caps (config.triggers)
 *   - `command` — interpreter resolution per script language
 *   - `output`  — stdout/stderr capture, payload truncation, wake firing
 *   - `exit`    — timeout/cancel/shutdown, child kill, finalizeExit, failTrigger
 *   - `spawn`   — the warden + direct spawn paths
 *   - `resume`  — post-restart respawn + orphan probe
 *
 * Knows nothing about backend or frontend — dependencies are injected.
 */

import { children, timeouts } from "./state.js";
import { commandForLanguage } from "./command.js";
import { handleStdoutLine } from "./output.js";
import { handleTimeout, finalizeExit } from "./exit.js";

export { initTriggers, getRunningCount } from "./state.js";
export {
  getTriggerCaps,
  triggerCapError,
  DEFAULT_TRIGGER_CAPS,
} from "./caps.js";
export { commandForLanguage } from "./command.js";
export { spawnTrigger } from "./spawn.js";
export { cancelTrigger, shutdownTriggers } from "./exit.js";
export { resumeAfterRestart } from "./resume.js";

// Internal exports for tests
export const _internals = {
  children,
  timeouts,
  handleStdoutLine,
  handleTimeout,
  finalizeExit,
  commandForLanguage,
};
