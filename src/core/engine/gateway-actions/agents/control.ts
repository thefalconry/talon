/**
 * Parent-side sub-agent actions — spawn, list, inspect, wait, message, kill.
 *
 * The caller is whoever the gateway routed: a chat (the ordinary chatKey) or
 * another sub-agent (`agent:<id>`, routed by the gateway's agent-context
 * branch). Both can delegate, so both go through the same handlers; the only
 * difference is the parent recorded on the new agent and which agents the
 * caller may see.
 *
 * Visibility is scoped like triggers are scoped to their chat: a chat sees the
 * agents rooted in it (descendants included), an agent sees its own
 * descendants. An id from another chat is simply "not found".
 */

import {
  agentIdFromContextLabel,
  agentRegistry,
  clampTimeout,
  describeTimeout,
  deliverToAgent,
  getAgentCaps,
  killAgent,
  spawnAgent,
  wantsPreflight,
  type AgentParent,
  type AgentRecord,
} from "../../../agents/index.js";
import { log } from "../../../../util/log.js";
import type { ReasoningEffortLevel } from "../../../types.js";
import type { ActionResult } from "../../../types.js";
import type { SharedActionHandlers } from "../types.js";

const EFFORTS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** Default and ceiling for `wait_for_agent`, in seconds. */
const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 120;

type Caller =
  | { kind: "chat"; chatKey: string; numericChatId: number }
  | { kind: "agent"; agentId: string };

/** Who is calling, read off the gateway's chat key. */
function callerOf(chatId: number, chatKey: string): Caller {
  const agentId = agentIdFromContextLabel(chatKey);
  return agentId
    ? { kind: "agent", agentId }
    : { kind: "chat", chatKey, numericChatId: chatId };
}

/** The parent a newly spawned agent gets. */
function parentOf(caller: Caller): AgentParent {
  return caller.kind === "chat"
    ? {
        kind: "chat",
        chatId: caller.chatKey,
        numericChatId: caller.numericChatId,
      }
    : { kind: "agent", agentId: caller.agentId };
}

/** The agents this caller is allowed to see and act on. */
function visible(caller: Caller): AgentRecord[] {
  if (caller.kind === "chat") return agentRegistry.listForChat(caller.chatKey);
  const seen: AgentRecord[] = [];
  const queue = [caller.agentId];
  // Breadth-first over the caller's own descendants; the registry's depth cap
  // bounds the walk, and `seen` ids are unique by construction.
  while (queue.length > 0) {
    const next = agentRegistry.get(queue.shift() as string);
    if (!next) continue;
    for (const child of next.children) {
      const record = agentRegistry.get(child);
      if (!record) continue;
      seen.push(record);
      queue.push(child);
    }
  }
  return seen;
}

/** Look one agent up within the caller's scope. */
function lookup(caller: Caller, id: string): AgentRecord | null {
  if (!id) return null;
  return visible(caller).find((record) => record.id === id) ?? null;
}

function notFound(id: string): ActionResult {
  return {
    ok: false,
    error: `No agent "${id}" in this chat. Call list_agents to see yours.`,
  };
}

function ageOf(record: AgentRecord): string {
  const end = record.endedAt ?? Date.now();
  return `${Math.round((end - record.createdAt) / 1000)}s`;
}

/** One line per agent for `list_agents`. */
function renderListEntry(record: AgentRecord): string {
  return (
    `- ${record.label} [${record.state}]\n` +
    `  ID: ${record.id}\n` +
    `  Backend: ${record.backendId}/${record.model ?? "(resolving)"}\n` +
    `  Depth: ${record.depth}  Age: ${ageOf(record)}  ` +
    `Result: ${record.result ? "yes" : "no"}`
  );
}

/** The full `agent_status` body — everything but the brief. */
function renderStatus(record: AgentRecord): string {
  const lines = [
    `Agent "${record.label}" (${record.id})`,
    `State: ${record.state}`,
    `Backend: ${record.backendId}/${record.model ?? "(resolving)"}` +
      (record.reasoningEffort ? ` effort=${record.reasoningEffort}` : ""),
    `Depth: ${record.depth}  Age: ${ageOf(record)}  Inbox: ${record.inboxDepth}`,
  ];
  if (record.children.length > 0) {
    lines.push(`Children: ${record.children.join(", ")}`);
  }
  if (record.usage) {
    lines.push(
      `Tokens: in=${record.usage.inputTokens} out=${record.usage.outputTokens}`,
    );
  }
  if (record.result) {
    lines.push("", `Result: ${record.result.summary}`);
    if (record.result.details) lines.push("", record.result.details);
  }
  if (record.error) lines.push("", `Error: ${record.error}`);
  if (!record.result && !record.error) {
    lines.push("", "No result yet — the agent is still working.");
  }
  return lines.join("\n");
}

/** Validate and normalise `spawn_agent`'s body. */
function readSpawnBody(body: Record<string, unknown>):
  | {
      ok: true;
      brief: string;
      label: string;
      backendId?: string;
      model?: string;
      reasoningEffort?: ReasoningEffortLevel;
      timeoutMs?: number;
      preflight: boolean;
    }
  | { ok: false; error: string } {
  const brief = String(body.brief ?? "").trim();
  if (!brief) return { ok: false, error: "Missing brief" };
  const label = String(body.label ?? "").trim();
  if (!label) return { ok: false, error: "Missing label" };
  const effort = body.effort === undefined ? undefined : String(body.effort);
  if (effort !== undefined && !EFFORTS.has(effort)) {
    return {
      ok: false,
      error: `Unknown effort "${effort}". Use minimal, low, medium, high or xhigh.`,
    };
  }
  const timeoutS =
    body.timeout_s === undefined ? undefined : Number(body.timeout_s);
  if (timeoutS !== undefined && !Number.isFinite(timeoutS)) {
    return { ok: false, error: "timeout_s must be a number of seconds" };
  }
  const preflight = body.preflight;
  if (preflight !== undefined && typeof preflight !== "boolean") {
    return { ok: false, error: "preflight must be true or false" };
  }
  return {
    ok: true,
    brief,
    label,
    preflight: wantsPreflight(brief, preflight),
    ...(body.backend ? { backendId: String(body.backend) } : {}),
    ...(body.model ? { model: String(body.model) } : {}),
    ...(effort !== undefined
      ? { reasoningEffort: effort as ReasoningEffortLevel }
      : {}),
    ...(timeoutS !== undefined
      ? { timeoutMs: clampTimeout(timeoutS * 1000) }
      : {}),
  };
}

export const agentControlHandlers: SharedActionHandlers = {
  spawn_agent: async (body, chatId, _backend, chatKey) => {
    const parsed = readSpawnBody(body);
    if (!parsed.ok) return parsed;
    const caller = callerOf(chatId, chatKey);
    const outcome = await spawnAgent({
      brief: parsed.brief,
      label: parsed.label,
      parent: parentOf(caller),
      ...(parsed.backendId ? { backendId: parsed.backendId } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.reasoningEffort
        ? { reasoningEffort: parsed.reasoningEffort }
        : {}),
      ...(parsed.timeoutMs !== undefined
        ? { timeoutMs: parsed.timeoutMs }
        : {}),
      preflight: parsed.preflight,
    });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    const timeout = describeTimeout(clampTimeout(parsed.timeoutMs));
    const stall = getAgentCaps().stallTimeoutMs;
    log("gateway", `spawn_agent: "${parsed.label}" [${outcome.agentId}]`);
    return {
      ok: true,
      text:
        `Spawned agent "${parsed.label}" (id: ${outcome.agentId})\n` +
        `Backend: ${outcome.backendId}/${outcome.model}` +
        `${outcome.routing ? ` (routed: ${outcome.routing})` : ""}\n` +
        `Timeout: ${timeout}` +
        (stall > 0
          ? ` (watchdog: pinged after ${describeTimeout(stall)} quiet, ` +
            `killed after ${describeTimeout(3 * stall)})`
          : "") +
        `\n` +
        (parsed.preflight ? `Pre-flight lane: on\n` : "") +
        `It runs in the background. You will be woken with its report — ` +
        `carry on with what you were doing.`,
    };
  },

  list_agents: (body, chatId, _backend, chatKey) => {
    const records = visible(callerOf(chatId, chatKey));
    if (records.length === 0) {
      return { ok: true, text: "No sub-agents for this chat." };
    }
    const caps = getAgentCaps();
    return {
      ok: true,
      text:
        `Agents (${records.length}, ${agentRegistry.liveCount()} live of ` +
        `${caps.maxConcurrent} daemon-wide):\n\n` +
        records.map(renderListEntry).join("\n\n"),
    };
  },

  agent_status: (body, chatId, _backend, chatKey) => {
    const id = String(body.agent_id ?? "");
    const record = lookup(callerOf(chatId, chatKey), id);
    if (!record) return notFound(id);
    return { ok: true, text: renderStatus(record) };
  },

  wait_for_agent: async (body, chatId, _backend, chatKey) => {
    const id = String(body.agent_id ?? "");
    const record = lookup(callerOf(chatId, chatKey), id);
    if (!record) return notFound(id);
    const requested = Number(body.timeout_s ?? DEFAULT_WAIT_S);
    const seconds = Math.min(
      MAX_WAIT_S,
      Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_WAIT_S),
    );
    const settled = await agentRegistry.waitForSettle(id, seconds * 1000);
    if (!settled) return notFound(id);
    if (settled.state === "running" || settled.state === "queued") {
      return {
        ok: true,
        text:
          `Agent "${settled.label}" (${id}) is still ${settled.state} after ` +
          `${seconds}s. Stop waiting — its report will wake you when it lands.`,
      };
    }
    return { ok: true, text: renderStatus(settled) };
  },

  send_to_agent: (body, chatId, _backend, chatKey) => {
    const id = String(body.agent_id ?? "");
    const caller = callerOf(chatId, chatKey);
    const record = lookup(caller, id);
    if (!record) return notFound(id);
    const text = String(body.text ?? "").trim();
    if (!text) return { ok: false, error: "Missing text" };
    const from = caller.kind === "chat" ? caller.chatKey : caller.agentId;
    if (!deliverToAgent(from, id, text)) {
      return {
        ok: false,
        error:
          `Could not deliver to "${id}": it has already settled, or its ` +
          `inbox is full. Check agent_status.`,
      };
    }
    return {
      ok: true,
      text: `Queued for agent "${record.label}" (${id}). It reads its inbox at its own milestones.`,
    };
  },

  kill_agent: (body, chatId, _backend, chatKey) => {
    const id = String(body.agent_id ?? "");
    const record = lookup(callerOf(chatId, chatKey), id);
    if (!record) return notFound(id);
    if (!killAgent(id)) {
      return {
        ok: true,
        text: `Agent "${record.label}" (${id}) had already settled as "${record.state}".`,
      };
    }
    return {
      ok: true,
      text: `Abort requested for agent "${record.label}" (${id}). You will still get its report.`,
    };
  },
};
