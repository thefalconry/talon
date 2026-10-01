/**
 * Agent-side sub-agent actions — the three tools that only mean something
 * inside a sub-agent run.
 *
 * The calling agent is identified from the gateway chat key (`agent:<id>`),
 * which the backend derives from the run's `contextLabel` and the MCP hub
 * binds to the tool session. Nothing is taken from the model's parameters:
 * an agent cannot claim to be a different agent, because it never names one.
 *
 * Called from a chat (or any other context) these are refused rather than
 * silently no-oping — a model that thinks it reported when it did not is the
 * one failure mode worth being loud about.
 */

import {
  agentIdFromContextLabel,
  agentRegistry,
  deliverMessage,
  deliverToAgent,
  describeParent,
} from "../../../agents/index.js";
import { logError } from "../../../../util/log.js";
import type { ActionResult } from "../../../types.js";
import type { AgentRecord } from "../../../agents/index.js";
import type { SharedActionHandlers } from "../types.js";

/** How `other` relates to `self` within their shared tree. */
function relation(self: AgentRecord, other: AgentRecord): string {
  if (self.parent.kind === "agent" && self.parent.agentId === other.id) {
    return "your parent";
  }
  if (other.parent.kind === "agent" && other.parent.agentId === self.id) {
    return "your child";
  }
  const sameParent =
    self.parent.kind === other.parent.kind &&
    (self.parent.kind === "chat"
      ? other.parent.kind === "chat" &&
        other.parent.chatId === self.parent.chatId
      : other.parent.kind === "agent" &&
        other.parent.agentId === self.parent.agentId);
  return sameParent ? "sibling" : `in your tree, depth ${other.depth}`;
}

/** One agent in a `list_peers` listing. */
function renderPeer(peer: AgentRecord, rel?: string): string {
  return (
    `- ${peer.label} [${peer.state}]${rel ? ` — ${rel}` : ""}\n` +
    `  ID: ${peer.id}\n` +
    `  Working on: ${peer.brief.slice(0, 160).replace(/\s+/g, " ")}…`
  );
}

function notAnAgent(tool: string): ActionResult {
  return {
    ok: false,
    error:
      `${tool} is only callable inside a sub-agent run. This context is a ` +
      `chat, which has no parent to report to.`,
  };
}

/** The live agent behind this chat key, or null when the caller isn't one. */
function callingAgent(chatKey: string): AgentRecord | null {
  const id = agentIdFromContextLabel(chatKey);
  if (!id || !agentRegistry.isLive(id)) return null;
  return agentRegistry.get(id);
}

export const agentReportHandlers: SharedActionHandlers = {
  report_result: (body, _chatId, _backend, chatKey) => {
    const record = callingAgent(chatKey);
    if (!record) return notAnAgent("report_result");
    const summary = String(body.summary ?? "").trim();
    if (!summary) return { ok: false, error: "Missing summary" };
    const details = body.details ? String(body.details).trim() : undefined;
    const stored = agentRegistry.report(record.id, {
      summary,
      ...(details ? { details } : {}),
    });
    if (!stored) {
      return {
        ok: false,
        error:
          "You have already reported a result. It is recorded and will be " +
          "delivered when your run ends — finish up instead of reporting again.",
      };
    }
    return {
      ok: true,
      text:
        `Result recorded. It is delivered to ${describeParent(record.parent)} ` +
        `when your run ends — you can stop now.`,
    };
  },

  message_parent: (body, _chatId, _backend, chatKey) => {
    const record = callingAgent(chatKey);
    if (!record) return notAnAgent("message_parent");
    const text = String(body.text ?? "").trim();
    if (!text) return { ok: false, error: "Missing text" };
    // Fire-and-forget: waking a chat runs a whole turn, and this tool call
    // must not block for the length of the parent's reply.
    void deliverMessage(record, text).catch((err: unknown) =>
      logError(
        "agents",
        `message_parent delivery failed for ${record.id}`,
        err,
      ),
    );
    return {
      ok: true,
      text: `Note sent to ${describeParent(record.parent)}. Carry on — this did not end your run.`,
    };
  },

  list_peers: (body, _chatId, _backend, chatKey) => {
    const record = callingAgent(chatKey);
    if (!record) return notAnAgent("list_peers");
    const scope = body.scope === undefined ? "siblings" : String(body.scope);
    if (scope !== "siblings" && scope !== "tree") {
      return {
        ok: false,
        error: `Unknown scope "${scope}". Use "siblings" or "tree".`,
      };
    }
    if (scope === "tree") {
      const tree = agentRegistry.treeOf(record.id);
      if (tree.length === 0) {
        return {
          ok: true,
          text: "No other live agents in your tree. Report to your parent as usual.",
        };
      }
      return {
        ok: true,
        text:
          `${tree.length} other live agent(s) in your tree (everything ` +
          `working for the same chat). Any of them can be reached with ` +
          `message_peer:\n\n` +
          tree
            .map((other) => renderPeer(other, relation(record, other)))
            .join("\n"),
      };
    }
    const peers = agentRegistry.peersOf(record.id);
    if (peers.length === 0) {
      return {
        ok: true,
        text:
          "No peers — you are the only agent your parent has running. " +
          'Report to your parent as usual (list_peers with scope "tree" ' +
          "shows the rest of your agent tree).",
      };
    }
    return {
      ok: true,
      text:
        `${peers.length} peer(s) running alongside you:\n\n` +
        peers.map((peer) => renderPeer(peer)).join("\n"),
    };
  },

  message_peer: (body, _chatId, _backend, chatKey) => {
    const record = callingAgent(chatKey);
    if (!record) return notAnAgent("message_peer");
    const target = String(body.agent_id ?? body.label ?? "").trim();
    if (!target) return { ok: false, error: "Missing agent_id (or label)" };
    const text = String(body.text ?? "").trim();
    if (!text) return { ok: false, error: "Missing text" };
    // Resolved through the caller's own tree: an agent can reach any live
    // agent working for the same chat, never one working for another — a
    // wrong or foreign id fails closed rather than delivering.
    const found = agentRegistry.findInTree(record.id, target);
    if (!found.ok) {
      return {
        ok: false,
        error:
          found.candidates.length > 1
            ? `"${target}" is ambiguous — ${found.candidates.length} live ` +
              `agents in your tree have that label ` +
              `(${found.candidates.map((c) => c.id).join(", ")}). Use the id.`
            : `No live agent "${target}" in your tree. You can message any ` +
              `live agent working for the same chat as you — call ` +
              `list_peers with scope "tree" to see them.`,
      };
    }
    const peer = found.record;
    if (!deliverToAgent(record.id, peer.id, text)) {
      return {
        ok: false,
        error:
          `Could not deliver to "${peer.label}" (${peer.id}): it has already ` +
          `settled, or its inbox is full.`,
      };
    }
    return {
      ok: true,
      text:
        `Queued for "${peer.label}" (${peer.id}, ${relation(record, peer)}). ` +
        `It reads its inbox at its own milestones, so this is not an interrupt.`,
    };
  },

  check_inbox: (_body, _chatId, _backend, chatKey) => {
    const record = callingAgent(chatKey);
    if (!record) return notAnAgent("check_inbox");
    const messages = agentRegistry.drain(record.id);
    if (messages.length === 0) {
      return { ok: true, text: "Inbox empty — no new instructions." };
    }
    const rendered = messages
      .map((message) => {
        const at = new Date(message.at).toISOString().slice(11, 19);
        return `[${at}] from ${message.from}:\n${message.text}`;
      })
      .join("\n\n");
    return {
      ok: true,
      text: `${messages.length} message(s):\n\n${rendered}`,
    };
  },
};
