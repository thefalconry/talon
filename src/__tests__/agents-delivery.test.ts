/**
 * Delivery — where a sub-agent's words go.
 *
 * A chat parent is woken with a synthetic `source: "agent"` turn; an agent
 * parent gets a mailbox push; a parent that has already settled gets nothing
 * but a log line. The registry here is the daemon singleton, because delivery
 * reads it by design (a mailbox belongs to a live agent, not to a handle).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  agentRegistry,
  deliverMessage,
  deliverSettlement,
  deliverToAgent,
  initAgentDelivery,
  type AgentParent,
  type AgentRecord,
} from "../core/agents/index.js";
import type { ExecuteParams, ExecuteResult } from "../core/types.js";

const CHAT: AgentParent = { kind: "chat", chatId: "d_77", numericChatId: 77 };

const execute = vi.fn(
  async (_params: ExecuteParams): Promise<ExecuteResult> => ({
    text: "",
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    bridgeMessageCount: 0,
  }),
);

/** Register + start one agent and return its live record. */
function live(parent: AgentParent, label = "probe"): AgentRecord {
  const outcome = agentRegistry.register(
    { label, brief: "secret brief", parent, backendId: "claude" },
    {
      maxConcurrent: 10,
      maxDepth: 3,
      defaultTimeoutMs: 1000,
      stallTimeoutMs: 0,
    },
  );
  if (!outcome.ok) throw new Error(outcome.error);
  agentRegistry.start(outcome.record.id, {
    model: "sonnet",
    abort: new AbortController(),
  });
  return agentRegistry.get(outcome.record.id) as AgentRecord;
}

function wakePrompt(): string {
  return execute.mock.calls[0]?.[0].prompt ?? "";
}

beforeEach(() => {
  agentRegistry.resetForTest();
  execute.mockClear();
  initAgentDelivery({ execute });
});

afterEach(() => {
  agentRegistry.resetForTest();
});

describe("deliverSettlement", () => {
  it("wakes a chat parent with a synthetic agent turn naming the agent", async () => {
    const record = live(CHAT, "pr-triage");
    agentRegistry.report(record.id, {
      summary: "three PRs are red",
      details: "#12 #13 #14",
    });
    const settled = agentRegistry.settle(record.id, { state: "done" });
    await deliverSettlement(settled as AgentRecord);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      chatId: "d_77",
      numericChatId: 77,
      senderName: "Agent",
      source: "agent",
      isGroup: false,
    });
    const prompt = wakePrompt();
    expect(prompt).toContain("AGENT FINISHED");
    expect(prompt).toContain(record.id);
    expect(prompt).toContain("pr-triage");
    expect(prompt).toContain("three PRs are red");
    expect(prompt).toContain("#12 #13 #14");
  });

  it("carries the failure reason when there was no result", async () => {
    const record = live(CHAT);
    const settled = agentRegistry.settle(record.id, {
      state: "timed_out",
      error: "isolated agent timed out after 900000ms",
    });
    await deliverSettlement(settled as AgentRecord);
    const prompt = wakePrompt();
    expect(prompt).toContain("timed_out");
    expect(prompt).toContain("timed out after");
  });

  it("pushes into an agent parent's mailbox instead of waking a chat", async () => {
    const parent = live(CHAT, "lead");
    const child = live({ kind: "agent", agentId: parent.id }, "worker");
    agentRegistry.report(child.id, { summary: "sub-result" });
    const settled = agentRegistry.settle(child.id, { state: "done" });
    await deliverSettlement(settled as AgentRecord);

    expect(execute).not.toHaveBeenCalled();
    const inbox = agentRegistry.drain(parent.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.from).toBe(child.id);
    expect(inbox[0]?.text).toContain("sub-result");
  });

  it("drops a report whose agent parent has already settled", async () => {
    const parent = live(CHAT, "lead");
    const child = live({ kind: "agent", agentId: parent.id }, "worker");
    agentRegistry.settle(parent.id, { state: "done" });
    const settled = agentRegistry.settle(child.id, {
      state: "done",
      result: { summary: "too late" },
    });
    await deliverSettlement(settled as AgentRecord);

    expect(execute).not.toHaveBeenCalled();
    expect(agentRegistry.drain(parent.id)).toEqual([]);
  });
});

describe("deliverMessage", () => {
  it("wakes a chat parent with an interim-note header", async () => {
    const record = live(CHAT, "watcher");
    await deliverMessage(record, "the build is still red");
    const prompt = wakePrompt();
    expect(prompt).toContain("AGENT MESSAGE from");
    expect(prompt).toContain(record.id);
    expect(prompt).toContain("watcher");
    expect(prompt).toContain("the build is still red");
  });

  it("pushes an interim note to an agent parent", async () => {
    const parent = live(CHAT, "lead");
    const child = live({ kind: "agent", agentId: parent.id }, "worker");
    await deliverMessage(child, "halfway there");
    expect(execute).not.toHaveBeenCalled();
    expect(agentRegistry.drain(parent.id)[0]?.text).toContain("halfway there");
  });
});

describe("deliverToAgent", () => {
  it("queues an instruction for a live agent", () => {
    const record = live(CHAT);
    expect(deliverToAgent("d_77", record.id, "also check the logs")).toBe(true);
    expect(agentRegistry.drain(record.id)[0]).toMatchObject({
      from: "d_77",
      text: "also check the logs",
    });
  });

  it("refuses once the agent has settled", () => {
    const record = live(CHAT);
    agentRegistry.settle(record.id, { state: "done" });
    expect(deliverToAgent("d_77", record.id, "too late")).toBe(false);
  });
});
