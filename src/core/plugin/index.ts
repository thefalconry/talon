/**
 * Plugin system — extensible tool integration for Talon.
 *
 * Split by responsibility:
 *   - `types`    — plugin interfaces, entry shapes, type guards, MCP config type
 *   - `registry` — the PluginRegistry singleton + reload-timestamp + `_deps`
 *   - `loader`   — load/validate/register plugins, init hooks, query helpers
 *   - `builtins` — built-in plugin loading + hot-reload
 *   - `actions`  — gateway-action routing through plugins
 *   - `mcp`      — MCP server spec assembly for the hub
 */

export { _deps } from "./registry.js";
export {
  loadPlugins,
  getLoadedPlugins,
  getPlugin,
  getPluginCount,
  destroyPlugins,
  getPluginPromptAdditions,
} from "./loader.js";
export { loadBuiltinPlugins, reloadPlugins } from "./builtins.js";
export {
  handlePluginAction,
  handlePluginActionIn,
  pluginsWithActions,
} from "./actions.js";
export { getPluginMcpServers } from "./mcp.js";
