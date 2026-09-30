/**
 * Sub-agent actions — the registry half of `core/tools/ops/agents.ts`.
 *
 *   - `control` — what a parent calls: spawn / list / status / wait / send /
 *     kill. Works from a chat and from inside another agent.
 *   - `report`  — what a sub-agent calls about itself and its siblings:
 *     report_result / message_parent / check_inbox / list_peers /
 *     message_peer.
 *   - `preflight` — run_preflight: the pre-flight lane (light CI suite) in
 *     the caller's checkout, so an agent pushes only on green.
 *
 * Both sets are reachable from an `agent:<id>` context: the gateway routes
 * those chat keys straight here (see `Gateway.handleAction`), because a
 * sub-agent has an identity but no chat, and `agentContextActions` is the
 * list it consults.
 */

import type { SharedActionHandlers } from "../types.js";
import { agentControlHandlers } from "./control.js";
import { agentPreflightHandlers } from "./preflight.js";
import { agentReportHandlers } from "./report.js";

export const agentHandlers: SharedActionHandlers = {
  ...agentControlHandlers,
  ...agentReportHandlers,
  ...agentPreflightHandlers,
};

/**
 * Actions the gateway will dispatch for an `agent:<id>` chat key. Everything
 * else stays chat-routed — a sub-agent calling a chat-scoped action still has
 * to name a chat explicitly, exactly as a heartbeat run does.
 */
export const agentContextActions: ReadonlySet<string> = new Set(
  Object.keys(agentHandlers),
);
