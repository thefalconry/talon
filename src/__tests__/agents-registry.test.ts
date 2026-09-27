/**
 * AgentRegistry — identity, caps, mailbox bounds, the settled ring, and the
 * result precedence the runner depends on.
 *
 * Constructed per test rather than using the daemon singleton, so nothing
 * here publishes on the real bus.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentRegistry,
  DEFAULT_AGENT_CAPS,
  type AgentCaps,
  type AgentParent,
} from "../core/agents/index.js";

const CHAT: AgentParent = { kind: "chat", chatId: "42", numericChatId: 42 };
const CAPS: AgentCaps = { ...DEFAULT_AGENT_CAPS };

function makeRegistry(
  options: ConstructorParameters<typeof AgentRegistry>[0] = {},
) {
  let seq = 0;
  return new AgentRegistry({ newId: () => `agt_${++seq}`, ...options });
}

function register(
  registry: AgentRegistry,
  parent: AgentParent = CHAT,
  caps: AgentCaps = CAPS,
) {
  return registry.register(
    { label: "work", brief: "do a thing", parent, backendId: "claude" },
    caps,
  );
}

function start(registry: AgentRegistry, id: string): void {
  registry.start(id, { model: "sonnet", abort: new AbortController() });
}

describe("AgentRegistry identity and lifecycle", () => {
  it("allocates an id and starts queued, binding the model only at start", () => {
    const registry = makeRegistry();
    const outcome = register(registry);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.id).toBe("agt_1");
    expect(outcome.record.state).toBe("queued");
    expect(outcome.record.model).toBeUndefined();

    start(registry, "agt_1");
    const running = registry.get("agt_1");
    expect(running?.state).toBe("running");
    expect(running?.model).toBe("sonnet");
  });

  it("publishes agent.spawned at start and agent.settled at settle, in order", () => {
    const publish = vi.fn();
    const registry = makeRegistry({ publish });
    register(registry);
    start(registry, "agt_1");
    registry.settle("agt_1", { state: "done" });
    expect(publish.mock.calls.map((call) => call[0].type)).toEqual([
      "agent.spawned",
      "agent.settled",
    ]);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      agentId: "agt_1",
      label: "work",
      parent: "42",
      parentKind: "chat",
      model: "sonnet",
      depth: 0,
    });
    // Content-free by contract: the brief never rides the bus.
    expect(JSON.stringify(publish.mock.calls)).not.toContain("do a thing");
  });

  it("discards a registration that never started, freeing its slot", () => {
    const registry = makeRegistry();
    register(registry);
    expect(registry.liveCount()).toBe(1);
    registry.discard("agt_1");
    expect(registry.liveCount()).toBe(0);
    expect(registry.get("agt_1")).toBeNull();
  });
});

describe("AgentRegistry caps", () => {
  it("refuses a spawn past maxConcurrent", () => {
    const registry = makeRegistry();
    const caps: AgentCaps = { ...CAPS, maxConcurrent: 2 };
    expect(register(registry, CHAT, caps).ok).toBe(true);
    expect(register(registry, CHAT, caps).ok).toBe(true);
    const third = register(registry, CHAT, caps);
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error).toContain("concurrency cap");
    expect(third.error).toContain("(2 live)");
    expect(third.error).toContain("agents.maxConcurrent");
  });

  it("defaults maxConcurrent to 6", () => {
    expect(DEFAULT_AGENT_CAPS.maxConcurrent).toBe(6);
    const registry = makeRegistry();
    for (let i = 0; i < 6; i++) expect(register(registry).ok).toBe(true);
    const seventh = register(registry);
    expect(seventh.ok).toBe(false);
    if (seventh.ok) return;
    expect(seventh.error).toContain("(6 live)");
  });

  it("frees the slot again once an agent settles", () => {
    const registry = makeRegistry();
    const caps: AgentCaps = { ...CAPS, maxConcurrent: 1 };
    register(registry, CHAT, caps);
    expect(register(registry, CHAT, caps).ok).toBe(false);
    registry.settle("agt_1", { state: "done" });
    expect(register(registry, CHAT, caps).ok).toBe(true);
  });

  it("counts depth from the chat and refuses past maxDepth", () => {
    const registry = makeRegistry();
    const caps: AgentCaps = { ...CAPS, maxDepth: 1, maxConcurrent: 10 };
    register(registry, CHAT, caps);
    const child = register(registry, { kind: "agent", agentId: "agt_1" }, caps);
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.record.depth).toBe(1);

    const grandchild = register(
      registry,
      { kind: "agent", agentId: "agt_2" },
      caps,
    );
    expect(grandchild.ok).toBe(false);
    if (grandchild.ok) return;
    expect(grandchild.error).toContain("depth cap");
  });

  it("refuses a child of an agent that has already settled", () => {
    const registry = makeRegistry();
    register(registry);
    registry.settle("agt_1", { state: "done" });
    const orphan = register(registry, { kind: "agent", agentId: "agt_1" });
    expect(orphan.ok).toBe(false);
    if (orphan.ok) return;
    expect(orphan.error).toContain("no longer running");
  });

  it("records the parent/child edge and reports live children", () => {
    const registry = makeRegistry();
    register(registry);
    register(registry, { kind: "agent", agentId: "agt_1" });
    expect(registry.get("agt_1")?.children).toEqual(["agt_2"]);
    expect(registry.liveChildren("agt_1")).toEqual(["agt_2"]);
    registry.settle("agt_2", { state: "done" });
    expect(registry.liveChildren("agt_1")).toEqual([]);
  });
});

describe("AgentRegistry mailbox", () => {
  it("delivers messages FIFO and drains them exactly once", () => {
    const registry = makeRegistry();
    register(registry);
    expect(registry.push("agt_1", { from: "42", text: "one", at: 1 })).toBe(
      true,
    );
    expect(registry.push("agt_1", { from: "42", text: "two", at: 2 })).toBe(
      true,
    );
    expect(registry.get("agt_1")?.inboxDepth).toBe(2);
    expect(registry.drain("agt_1").map((m) => m.text)).toEqual(["one", "two"]);
    expect(registry.drain("agt_1")).toEqual([]);
  });

  it("refuses a push past the mailbox cap rather than dropping silently", () => {
    const registry = makeRegistry({ mailboxLimit: 2 });
    register(registry);
    expect(registry.push("agt_1", { from: "42", text: "a", at: 1 })).toBe(true);
    expect(registry.push("agt_1", { from: "42", text: "b", at: 2 })).toBe(true);
    expect(registry.push("agt_1", { from: "42", text: "c", at: 3 })).toBe(
      false,
    );
    expect(registry.drain("agt_1").map((m) => m.text)).toEqual(["a", "b"]);
  });

  it("refuses a push to an agent that has settled", () => {
    const registry = makeRegistry();
    register(registry);
    registry.settle("agt_1", { state: "done" });
    expect(registry.push("agt_1", { from: "42", text: "x", at: 1 })).toBe(
      false,
    );
  });
});

describe("AgentRegistry result precedence", () => {
  it("keeps the reported result when the run settles", () => {
    const registry = makeRegistry();
    register(registry);
    expect(registry.report("agt_1", { summary: "reported" })).toBe(true);
    expect(registry.hasReported("agt_1")).toBe(true);
    const settled = registry.settle("agt_1", { state: "done" });
    expect(settled?.result).toEqual({ summary: "reported" });
  });

  it("refuses a second report so a parent never gets two answers", () => {
    const registry = makeRegistry();
    register(registry);
    expect(registry.report("agt_1", { summary: "first" })).toBe(true);
    expect(registry.report("agt_1", { summary: "second" })).toBe(false);
    expect(registry.settle("agt_1", { state: "done" })?.result).toEqual({
      summary: "first",
    });
  });

  it("takes the settlement's fallback result when nothing was reported", () => {
    const registry = makeRegistry();
    register(registry);
    const settled = registry.settle("agt_1", {
      state: "done",
      result: { summary: "captured text" },
    });
    expect(settled?.result).toEqual({ summary: "captured text" });
  });

  it("leaves the result null when there was neither", () => {
    const registry = makeRegistry();
    register(registry);
    const settled = registry.settle("agt_1", { state: "failed", error: "no" });
    expect(settled?.result).toBeNull();
    expect(settled?.error).toBe("no");
  });

  it("is idempotent — a second settle is a no-op", () => {
    const registry = makeRegistry();
    register(registry);
    expect(registry.settle("agt_1", { state: "done" })?.state).toBe("done");
    expect(registry.settle("agt_1", { state: "failed" })).toBeNull();
    expect(registry.get("agt_1")?.state).toBe("done");
  });
});

describe("AgentRegistry reads", () => {
  it("bounds the settled ring and keeps the newest entries", () => {
    const registry = makeRegistry({ historyLimit: 2 });
    for (let i = 1; i <= 4; i++) {
      register(registry);
      registry.settle(`agt_${i}`, { state: "done" });
    }
    expect(registry.list().map((r) => r.id)).toEqual(["agt_3", "agt_4"]);
  });

  it("scopes listForChat to the chat an agent's ancestry roots in", () => {
    const registry = makeRegistry();
    register(registry, CHAT);
    register(registry, { kind: "agent", agentId: "agt_1" });
    register(registry, { kind: "chat", chatId: "99", numericChatId: 99 });
    expect(registry.listForChat("42").map((r) => r.id)).toEqual([
      "agt_1",
      "agt_2",
    ]);
    expect(registry.listForChat("99").map((r) => r.id)).toEqual(["agt_3"]);
  });

  it("requests a kill through the run's abort handle, once", () => {
    const registry = makeRegistry();
    register(registry);
    const abort = new AbortController();
    const spy = vi.spyOn(abort, "abort");
    registry.start("agt_1", { model: "sonnet", abort });
    expect(registry.requestKill("agt_1")).toBe(true);
    expect(registry.requestKill("agt_1")).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    expect(registry.killRequested("agt_1")).toBe(true);
  });

  it("honours a kill requested while still queued when the abort handle binds at start", () => {
    const registry = makeRegistry();
    register(registry);
    // Kill arrives during the queued window — before any abort handle exists,
    // so this only records the flag (nothing to abort yet).
    expect(registry.requestKill("agt_1")).toBe(true);
    expect(registry.killRequested("agt_1")).toBe(true);
    // When the handle finally binds at start(), the pending kill must reach it,
    // or the fresh un-aborted controller lets the run proceed and the kill is lost.
    const abort = new AbortController();
    registry.start("agt_1", { model: "sonnet", abort });
    expect(abort.signal.aborted).toBe(true);
  });

  it("killAll signals every live agent", () => {
    const registry = makeRegistry();
    register(registry);
    register(registry);
    start(registry, "agt_1");
    start(registry, "agt_2");
    expect(registry.killAll()).toBe(2);
  });

  it("waitForSettle resolves on settlement and on timeout", async () => {
    const registry = makeRegistry();
    register(registry);
    start(registry, "agt_1");
    const waiting = registry.waitForSettle("agt_1", 5_000);
    registry.settle("agt_1", { state: "done" });
    expect((await waiting)?.state).toBe("done");

    register(registry);
    start(registry, "agt_2");
    const timedOut = await registry.waitForSettle("agt_2", 5);
    expect(timedOut?.state).toBe("running");
  });
});
