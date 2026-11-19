/**
 * Claude SDK backend — barrel re-export.
 *
 * All consumers import from this file; the implementation is split across
 * focused modules for readability and maintainability.
 */

export { initAgent, updateSystemPrompt } from "./state.js";
export { warmSession } from "./session/warm.js";
export { getActiveQuery } from "./handler.js";
export { buildMcpServers, buildPluginMcpServers } from "./options.js";
export { runOneShotAgent, evictOrphanSubprocesses } from "./one-shot.js";
