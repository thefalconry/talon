/**
 * Talon entry shim.
 *
 * Dispatches the hidden `_mcp-launch` (MCP supervisor), `_mcp-reaper`
 * (hub MCP child reaper), `_lua-run` (WASM Lua trigger runner) and
 * `_handoff-watch` (restart/update witness) subcommands BEFORE the app
 * graph loads — all of them are Talon re-invoking itself (see
 * core/mcp-hub/launcher.ts, core/mcp-hub/child-guard.ts,
 * core/daemon/handoff.ts). Every branch is a dynamic import, so each
 * helper process evaluates this shim and its own module only — never
 * another helper's, and never the backends/frontends/plugins.
 */

import { installSignalListenerGuard } from "./core/daemon/signals.js";

// Subcommand names are literals here, not imports: importing them would
// load every helper's module into every helper process. Each is pinned
// to its module's exported constant by entry-dispatch.test.ts.
const subcommand = process.argv[2];

// Before anything can remove a signal listener: under Bun that would
// silently disarm SIGTERM/SIGINT for the whole process (core/daemon/
// signals.ts). Every Talon process passes through here, so every one
// is covered.
installSignalListenerGuard();

if (subcommand === "_mcp-launch") {
  const { runSupervisor } = await import("./core/mcp-hub/launcher.js");
  await runSupervisor(process.argv.slice(3));
} else if (subcommand === "_mcp-reaper") {
  const { runReaper } = await import("./core/mcp-hub/reaper.js");
  await runReaper();
} else if (subcommand === "_lua-run") {
  const { runLuaMain } = await import("./core/scripts/lua.js");
  await runLuaMain(process.argv.slice(3));
} else if (subcommand === "_handoff-watch") {
  const { runHandoffWatch } = await import("./core/daemon/handoff.js");
  await runHandoffWatch(process.argv.slice(3));
} else {
  await import("./app.js");
}
