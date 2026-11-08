#!/usr/bin/env node
/**
 * Talon CLI entry point.
 *
 * Usage:
 *   talon              — interactive menu (runs setup on first launch)
 *   talon setup        — guided setup wizard
 *   talon status       — show bot health and stats
 *   talon config       — view/edit configuration
 *   talon logs         — tail the log file with formatting
 *   talon start        — start the bot directly
 *   talon chat         — terminal chat mode
 *
 * This file stays intentionally thin: it handles the must-run-first hidden
 * subcommand dispatch (below), then hands off to the command router in
 * `cli/index.ts`. Everything else lives under `cli/`.
 */

// Hidden subcommand dispatch — must run before anything else. Talon
// supervises MCP stdio children (`_mcp-launch`, `_mcp-reaper`) and runs
// WASM-sandboxed Lua trigger scripts (`_lua-run`) by re-invoking its own
// entrypoint (see core/mcp-hub/launcher.ts). None of these calls resolves;
// the helper process exits from its own handlers. Names are literals and
// modules load dynamically so a helper process only evaluates its own
// module (pinned to the exported constants by entry-dispatch.test.ts).
const subcommand = process.argv[2];
if (subcommand === "_mcp-launch") {
  const { runSupervisor } = await import("./core/mcp-hub/launcher.js");
  await runSupervisor(process.argv.slice(3));
} else if (subcommand === "_mcp-reaper") {
  const { runReaper } = await import("./core/mcp-hub/reaper.js");
  await runReaper();
} else if (subcommand === "_lua-run") {
  const { runLuaMain } = await import("./core/scripts/lua.js");
  await runLuaMain(process.argv.slice(3));
} else {
  const { runCli } = await import("./cli/index.js");
  await runCli();
}

// No static imports (see above) — mark the file as an ES module so
// top-level await type-checks.
export {};
