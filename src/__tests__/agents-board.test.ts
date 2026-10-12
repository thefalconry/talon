/**
 * Sub-agent blackboard and advisory leases: tree-scoped visibility, lease
 * conflict / release / expiry, and the cap and rate limit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_RATE_WINDOW_MS,
  resetBoardForTest,
} from "../core/agents/board.js";
import {
  agentContextLabel,
  agentRegistry,
  type AgentParent,
  type AgentRecord,
} from "../core/agents/index.js";
import { handleAgentContextAction } from "../core/engine/gateway-actions/index.js";
import type { ActionResult } from "../core/types.js";

const CHAT_A: AgentParent = { kind: "chat", chatId: "d_1", numericChatId: 1 };
const CHAT_B: AgentParent = { kind: "chat", chatId: "d_2", numericChatId: 2 };

function live(parent: AgentParent, label: string): AgentRecord {
  const outcome = agentRegistry.register(
    { label, brief: "brief", parent, backendId: "claude" },
    {
      maxConcurrent: 20,
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

async function asAgent(
  agentId: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<ActionResult> {
  const result = await handleAgentContextAction(
    { action, ...body },
    agentContextLabel(agentId),
  );
  if (!result) throw new Error(`action ${action} was not routed`);
  return result;
}

const post = (id: string, text: string, topic = "t", kind = "finding") =>
  asAgent(id, "board_post", { topic, kind, text });

beforeEach(() => {
  agentRegistry.resetForTest();
  resetBoardForTest();
});

afterEach(() => {
  vi.useRealTimers();
  agentRegistry.resetForTest();
  resetBoardForTest();
});

describe("blackboard", () => {
  it("shows a claim to a sibling in the same tree, with the author label", async () => {
    const a = live(CHAT_A, "researcher");
    const b = live(CHAT_A, "builder");
    expect(
      (await post(a.id, "I am editing registry.ts", "registry", "claim")).ok,
    ).toBe(true);
    const read = await asAgent(b.id, "board_read", {});
    expect(read.ok).toBe(true);
    expect(read.text).toContain("[claim] registry — researcher");
    expect(read.text).toContain("I am editing registry.ts");
  });

  it("filters by topic and since_id", async () => {
    const a = live(CHAT_A, "a");
    await post(a.id, "one", "x");
    await post(a.id, "two", "y");
    const byTopic = await asAgent(a.id, "board_read", { topic: "y" });
    expect(byTopic.text).toContain("two");
    expect(byTopic.text).not.toContain("one");
    const since = await asAgent(a.id, "board_read", { since_id: 1000000 });
    expect(since.text).toContain("Board empty");
  });

  it("never shows entries to an agent in another chat's tree", async () => {
    const a = live(CHAT_A, "a");
    const other = live(CHAT_B, "other");
    await post(a.id, "secret finding");
    const read = await asAgent(other.id, "board_read", {});
    expect(read.text).not.toContain("secret finding");
    expect(read.text).toContain("Board empty");
  });

  it("shares the board between a parent agent and its child", async () => {
    const parent = live(CHAT_A, "parent-agent");
    const child = live({ kind: "agent", agentId: parent.id }, "child-agent");
    await post(child.id, "from the child");
    expect((await asAgent(parent.id, "board_read", {})).text).toContain(
      "child-agent",
    );
  });

  it("refuses a chat caller and an oversized or unknown-kind post", async () => {
    const a = live(CHAT_A, "a");
    expect((await post(a.id, "x".repeat(4097))).ok).toBe(false);
    expect((await post(a.id, "x", "t", "lease")).ok).toBe(false);
  });

  it(`keeps 200 live entries, dropping the oldest non-lease first`, async () => {
    vi.useFakeTimers();
    const a = live(CHAT_A, "a");
    for (let i = 0; i < 200 + 5; i++) {
      // Stay inside everyone's rate budget.
      vi.advanceTimersByTime(BOARD_RATE_WINDOW_MS);
      await post(a.id, `entry ${i}`);
    }
    const read = await asAgent(a.id, "board_read", {});
    const count = (read.text ?? "").match(/^#\d+ \[/gm)?.length ?? 0;
    expect(count).toBe(200);
    expect(read.text).not.toContain("entry 0\n");
    expect(read.text).toContain(`entry ${200 + 4}`);
  });

  it("keeps a live lease when the cap drops older entries", async () => {
    const a = live(CHAT_A, "a");
    const b = live(CHAT_A, "b");
    await asAgent(a.id, "lease", { op: "acquire", resource: "keep-me" });
    // 11 writers' worth of budget: spread over distinct agents.
    const writers = [
      b,
      ...Array.from({ length: 10 }, (_, i) => live(CHAT_A, `w${i}`)),
    ];
    let n = 0;
    for (const w of writers) {
      for (let i = 0; i < 20 && n < 200 + 10; i++, n++) {
        await post(w.id, `n${n}`);
      }
    }
    const read = await asAgent(a.id, "board_read", {});
    expect(read.text).toContain("[lease] keep-me");
    expect((read.text ?? "").match(/^#\d+ \[/gm)?.length).toBe(200);
  });

  it("rate-limits an agent, per window", async () => {
    vi.useFakeTimers();
    const a = live(CHAT_A, "a");
    const b = live(CHAT_A, "b");
    for (let i = 0; i < 20; i++) {
      expect((await post(a.id, `p${i}`)).ok).toBe(true);
    }
    const over = await post(a.id, "one too many");
    expect(over.ok).toBe(false);
    expect(over.error).toContain("Rate limit");
    // Another agent has its own budget.
    expect((await post(b.id, "fine")).ok).toBe(true);
    vi.advanceTimersByTime(BOARD_RATE_WINDOW_MS + 1);
    expect((await post(a.id, "after the window")).ok).toBe(true);
  });
});

describe("leases", () => {
  it("refuses a second holder and names the first", async () => {
    const a = live(CHAT_A, "holder");
    const b = live(CHAT_A, "latecomer");
    expect(
      (
        await asAgent(a.id, "lease", {
          op: "acquire",
          resource: "branch:x",
          ttl_s: 300,
        })
      ).ok,
    ).toBe(true);
    const refused = await asAgent(b.id, "lease", {
      op: "acquire",
      resource: "branch:x",
    });
    expect(refused.ok).toBe(false);
    const body = JSON.parse(refused.error ?? "{}") as Record<string, unknown>;
    expect(body.held_by).toBe("holder");
    expect(body.expires_in).toBeGreaterThan(290);
    const listed = await asAgent(b.id, "lease", { op: "list" });
    expect(listed.text).toContain("branch:x");
  });

  it("lets the holder renew and release; others cannot release", async () => {
    const a = live(CHAT_A, "a");
    const b = live(CHAT_A, "b");
    await asAgent(a.id, "lease", { op: "acquire", resource: "r" });
    expect(
      (await asAgent(a.id, "lease", { op: "acquire", resource: "r" })).text,
    ).toContain("Renewed");
    expect(
      (await asAgent(b.id, "lease", { op: "release", resource: "r" })).text,
    ).toContain("hold no live lease");
    expect(
      (await asAgent(a.id, "lease", { op: "release", resource: "r" })).text,
    ).toContain("Released");
    expect(
      (await asAgent(b.id, "lease", { op: "acquire", resource: "r" })).ok,
    ).toBe(true);
  });

  it("releases an agent's leases when it settles", async () => {
    const a = live(CHAT_A, "a");
    const b = live(CHAT_A, "b");
    await asAgent(a.id, "lease", { op: "acquire", resource: "r", ttl_s: 1800 });
    expect(
      (await asAgent(b.id, "lease", { op: "acquire", resource: "r" })).ok,
    ).toBe(false);
    agentRegistry.settle(a.id, { state: "failed", error: "boom" });
    expect(
      (await asAgent(b.id, "lease", { op: "acquire", resource: "r" })).ok,
    ).toBe(true);
  });

  it("frees a lease when its TTL lapses", async () => {
    vi.useFakeTimers();
    const a = live(CHAT_A, "a");
    const b = live(CHAT_A, "b");
    await asAgent(a.id, "lease", { op: "acquire", resource: "r", ttl_s: 60 });
    vi.advanceTimersByTime(59_000);
    expect(
      (await asAgent(b.id, "lease", { op: "acquire", resource: "r" })).ok,
    ).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(
      (await asAgent(b.id, "lease", { op: "acquire", resource: "r" })).ok,
    ).toBe(true);
  });

  it("caps the ttl at 1800s and scopes leases to the chat tree", async () => {
    const a = live(CHAT_A, "a");
    const other = live(CHAT_B, "other");
    const got = await asAgent(a.id, "lease", {
      op: "acquire",
      resource: "r",
      ttl_s: 99999,
    });
    expect(got.text).toContain("1800s");
    // Same resource name in another chat is a different lease.
    expect(
      (await asAgent(other.id, "lease", { op: "acquire", resource: "r" })).ok,
    ).toBe(true);
    expect(
      (await asAgent(other.id, "lease", { op: "list" })).text,
    ).not.toContain("a (");
  });
});
