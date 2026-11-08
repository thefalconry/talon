/**
 * Heartbeat — periodic background agent for user-defined maintenance tasks.
 *
 * Runs at a configurable interval (default: 60 minutes). The agent reads
 * instructions from ~/.talon/workspace/heartbeat-instructions.md and executes
 * them using filesystem tools and all loaded MCP plugins.
 *
 * Split by responsibility:
 *   - `state`     — shared run-guard/timers/config + persisted-state I/O
 *   - `agent`     — prompt building + the one-shot agent run + log helpers
 *   - `scheduler` — init, the cadence timer, run guard, force/await/status API
 */

export {
  initHeartbeat,
  startHeartbeatTimer,
  stopHeartbeatTimer,
  awaitCurrentRun,
  forceHeartbeat,
  getHeartbeatStatus,
} from "./scheduler.js";
export { buildHeartbeatSystemPrompt } from "./agent.js";
