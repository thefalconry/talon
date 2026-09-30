/**
 * Sub-agents — the public surface.
 *
 * Talon's own delegation mechanism: any chat turn, on any backend, can spawn
 * an isolated agent with its own backend and model, talk to it while it runs,
 * and be woken with its report. See `docs/agents.md` for the model and
 * `registry` / `runner` / `delivery` for the three moving parts.
 *
 * Wiring points: `initAgents` at the composition root (bootstrap),
 * `shutdownAgents` on daemon teardown (app), the `agents` tool family
 * (`core/tools/ops/agents.ts`) through `core/engine/gateway-actions/agents/`,
 * and `GET /agents` on the gateway.
 *
 * `context.ts` is imported directly by `backend/claude-sdk` and the gateway:
 * it is a dependency-free leaf on purpose, so knowing what an `agent:<id>`
 * label looks like never drags the runner (and the backend pool) along.
 */

export { agentContextLabel, agentIdFromContextLabel } from "./context.js";
export { AgentRegistry, agentRegistry } from "./registry.js";
export {
  DEFAULT_AGENT_CAPS,
  clampTimeout,
  getAgentCaps,
  initAgents,
  interruptAgentsForRestart,
  killAgent,
  resumeAgentsAfterRestart,
  shutdownAgents,
  spawnAgent,
} from "./runner.js";
export {
  deliverMessage,
  deliverSettlement,
  deliverToAgent,
  initAgentDelivery,
} from "./delivery.js";
export { describeParent, wantsPreflight } from "./prompt.js";
export type { AgentCaps, AgentParent, AgentRecord } from "./types.js";
