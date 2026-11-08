/**
 * Memory gateway actions — remember / recall / forget over the typed
 * store, through `handleSharedAction`.
 *
 * Runs against the real (per-worker throwaway) SQLite database, like
 * goal-actions.test.ts: the store's own lifecycle is covered by
 * storage-memory.test.ts, and what is under test here is the write-path
 * policy that lives above it — the near-duplicate refusal, the trust the
 * chat implies, and the prompt-cache invariant of plan §3.6.
 *
 * The database is shared across this file, so every case works under its
 * own unique subject / state key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// The cache invariant (plan §3.6): a memory write that invalidated every
// live session's prompt snapshot turns a ~50-token claim into a 60–90 k
// cache write. The spy below is asserted to stay untouched.
const notifyPromptInputsChanged = vi.fn();
vi.mock("../core/prompt/invalidation.js", () => ({
  notifyPromptInputsChanged,
  onPromptInputsChanged: vi.fn(),
}));

import { handleSharedAction } from "../core/engine/gateway-actions/index.js";
import {
  assertMemory,
  getMemory,
  listMemories,
  MEMORY_KINDS,
  type MemoryRow,
} from "../storage/memory.js";
import { ALL_TOOLS } from "../core/tools/index.js";
import type { ActionResult } from "../core/types.js";

/** A DM chat key — `chatScope` reads a positive Telegram id as a DM. */
const DM_CHAT = "424242420";
/** A Telegram supergroup: negative id. */
const GROUP_CHAT = "-1009876543210";

let seq = 0;
/** Unique subject per test — the worker-shared DB persists across tests. */
function freshSubject(): string {
  return `mem-act-${++seq}-${Date.now()}`;
}

async function act(
  body: Record<string, unknown>,
  chatKey: string = DM_CHAT,
): Promise<ActionResult> {
  const result = await handleSharedAction(body, 1, undefined, chatKey);
  expect(result).not.toBeNull();
  return result!;
}

function liveRows(subject: string): MemoryRow[] {
  return listMemories({ subject });
}

describe("remember", () => {
  let subject: string;
  beforeEach(() => {
    subject = freshSubject();
  });

  it("inserts a claim and returns its formatted line", async () => {
    const result = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "Ada ships on Fridays",
    });
    expect(result.ok).toBe(true);
    expect(result.line).toBe(
      `#${result.id} [fact] ${subject}: Ada ships on Fridays`,
    );
    const row = getMemory(result.id as number)!;
    expect(row.trust).toBe("agent");
    expect(row.source).toEqual({ chat: DM_CHAT, actor: "remember" });
    expect(row.confidence).toBe(1);
  });

  it("carries an explicit confidence through to the row", async () => {
    const result = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "the deploy window is probably Tuesday",
      confidence: 0.4,
    });
    expect(getMemory(result.id as number)!.confidence).toBe(0.4);
  });

  it("defaults the subject to the chat for episode and relationship", async () => {
    const episode = await act({
      action: "remember",
      kind: "episode",
      text: "argued about tabs again",
    });
    expect(getMemory(episode.id as number)!.subject).toBe(DM_CHAT);
    const rel = await act({
      action: "remember",
      kind: "relationship",
      text: "prefers terse answers",
    });
    expect(getMemory(rel.id as number)!.subject).toBe(DM_CHAT);
  });

  it("requires a subject for every other kind", async () => {
    const result = await act({
      action: "remember",
      kind: "fact",
      text: "no subject here",
    });
    expect(result).toEqual({
      ok: false,
      error: "A fact memory needs a subject (who or what it is about)",
    });
  });

  // ── The supersede-candidate rule (plan §3.2) ──────────────────────────

  it("refuses a near-duplicate and offers the rows to supersede", async () => {
    const first = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "the release ships on Friday",
    });
    const second = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "the release ships on Friday afternoon",
    });
    expect(second.ok).toBe(false);
    expect(second.error).toBe(`Near-duplicate of #${first.id}`);
    expect(second.similar).toEqual([
      `#${first.id} [fact] ${subject}: the release ships on Friday`,
    ]);
    expect(second.hint).toContain("replace_id");
    // Nothing was written: the refusal is the whole effect.
    expect(liveRows(subject)).toHaveLength(1);
  });

  it("supersedes the named row when replace_id answers the refusal", async () => {
    const first = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "Ada lives in London",
    });
    const replaced = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "Ada lives in Lisbon",
      replace_id: first.id,
    });
    expect(replaced.ok).toBe(true);
    expect(getMemory(first.id as number)!.supersededBy).toBe(replaced.id);
    const live = liveRows(subject);
    expect(live).toHaveLength(1);
    expect(live[0]!.text).toBe("Ada lives in Lisbon");
  });

  it("stores a separate claim when force is set", async () => {
    await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "the release ships on Friday",
    });
    const forced = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "the release ships on Friday afternoon",
      force: true,
    });
    expect(forced.ok).toBe(true);
    expect(liveRows(subject)).toHaveLength(2);
  });

  it("refuses a replace_id that would escalate the row's trust", async () => {
    // Written in a DM, so the row is agent trust.
    const dmClaim = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "the staging key rotates on Mondays",
    });
    expect(getMemory(dmClaim.id as number)!.trust).toBe("agent");

    // A group participant tries to hand it new text. `supersedeMemory`
    // would copy the agent trust onto the successor, so this is refused.
    const escalation = await act(
      {
        action: "remember",
        kind: "fact",
        subject,
        text: "the staging key rotates on Fridays",
        replace_id: dmClaim.id,
      },
      GROUP_CHAT,
    );
    expect(escalation.ok).toBe(false);
    expect(escalation.error).toBe(
      `Memory #${dmClaim.id} was recorded at agent trust; a group_chat context cannot replace it — record a separate claim instead`,
    );
    // The original stands, and nothing was written.
    const live = liveRows(subject);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(dmClaim.id);
    expect(live[0]!.text).toBe("the staging key rotates on Mondays");
    expect(getMemory(dmClaim.id as number)!.supersededBy).toBeUndefined();
  });

  it("allows a replace_id at the same tier or weaker", async () => {
    const weak = assertMemory({
      kind: "fact",
      subject,
      text: "someone in the group said the build is red",
      trust: "group_chat",
    });
    // A DM context outranks group_chat, so it may fold the row.
    const replaced = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "the build is green again",
      replace_id: weak.id,
    });
    expect(replaced.ok).toBe(true);
    expect(getMemory(weak.id)!.supersededBy).toBe(replaced.id);
  });

  it("rejects a replace_id that is not live, or is the wrong kind", async () => {
    const fact = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "something true",
    });
    const wrongKind = await act({
      action: "remember",
      kind: "episode",
      subject,
      text: "something else",
      replace_id: fact.id,
    });
    expect(wrongKind.ok).toBe(false);
    expect(wrongKind.error).toContain("is a fact, not a episode");

    const missing = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "something else again",
      replace_id: 987_654_321,
    });
    expect(missing).toEqual({
      ok: false,
      error: "No memory with id 987654321",
    });
  });

  // ── Keyed state ───────────────────────────────────────────────────────

  it("replaces the live row for a state key instead of appending", async () => {
    const key = `${subject.replaceAll(/[^a-z0-9]/g, "")}.health`;
    const first = await act({
      action: "remember",
      kind: "state",
      subject,
      key,
      text: "green",
    });
    const second = await act({
      action: "remember",
      kind: "state",
      subject,
      key,
      text: "green, 2 retries",
    });
    expect(second.ok).toBe(true);
    expect(getMemory(first.id as number)!.supersededBy).toBe(second.id);
    const live = liveRows(subject);
    expect(live).toHaveLength(1);
    expect(live[0]!.key).toBe(key);
    // The keyed replace is the dedupe — no near-duplicate refusal in the way.
    expect(second.line).toContain(key);
  });

  it("requires a key for state and refuses replace_id there", async () => {
    const noKey = await act({
      action: "remember",
      kind: "state",
      subject,
      text: "green",
    });
    expect(noKey.ok).toBe(false);
    expect(noKey.error).toContain("requires a key");

    const withReplace = await act({
      action: "remember",
      kind: "state",
      subject,
      key: "some.key",
      text: "green",
      replace_id: 1,
    });
    expect(withReplace.ok).toBe(false);
    expect(withReplace.error).toContain("omit replace_id");
  });

  // ── Trust comes from the chat (plan §5) ───────────────────────────────

  it("writes group_chat trust from a group chat", async () => {
    const result = await act(
      { action: "remember", kind: "fact", subject, text: "overheard in here" },
      GROUP_CHAT,
    );
    expect(getMemory(result.id as number)!.trust).toBe("group_chat");
  });

  it("fails closed to group_chat when the id grammar cannot tell", async () => {
    const result = await act(
      { action: "remember", kind: "fact", subject, text: "from a teams chat" },
      "teams_chat_19:abc@thread.v2",
    );
    expect(getMemory(result.id as number)!.trust).toBe("group_chat");
  });

  it("refuses a directive from a group chat", async () => {
    const result = await act(
      {
        action: "remember",
        kind: "directive",
        subject,
        text: "always reply in French",
      },
      GROUP_CHAT,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be recorded from a group chat");
    expect(liveRows(subject)).toHaveLength(0);
  });

  it("accepts a directive from a DM", async () => {
    const result = await act({
      action: "remember",
      kind: "directive",
      subject,
      text: "always reply in French",
    });
    expect(result.ok).toBe(true);
    expect(getMemory(result.id as number)!.trust).toBe("agent");
  });

  // ── Validation ────────────────────────────────────────────────────────

  it("rejects an unknown kind and empty text", async () => {
    const badKind = await act({
      action: "remember",
      kind: "vibes",
      subject,
      text: "hm",
    });
    expect(badKind.ok).toBe(false);
    expect(badKind.error).toContain('Unknown kind "vibes"');

    const noText = await act({ action: "remember", kind: "fact", subject });
    expect(noText.ok).toBe(false);
    expect(noText.error).toContain("Missing text");
  });

  it("returns a store error as { ok: false } rather than throwing", async () => {
    const result = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "x".repeat(4_001),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("too long");
  });
});

describe("recall", () => {
  it("returns matching rows and bumps their hit count", async () => {
    const subject = freshSubject();
    const token = `zqxtoken${seq}`;
    const { id } = assertMemory({
      kind: "fact",
      subject,
      text: `the ${token} lives in the attic`,
      trust: "operator",
    });
    expect(getMemory(id)!.hitCount).toBe(0);

    const result = await act({ action: "recall", query: token });
    expect(result.ok).toBe(true);
    expect(result.rows).toContain(
      `#${id} [fact] ${subject}: the ${token} lives in the attic`,
    );
    expect(getMemory(id)!.hitCount).toBe(1);
  });

  it("filters by kind", async () => {
    const subject = freshSubject();
    const token = `zqykind${seq}`;
    assertMemory({
      kind: "fact",
      subject,
      text: `${token} as a fact`,
      trust: "operator",
    });
    const episode = assertMemory({
      kind: "episode",
      subject,
      text: `${token} as an episode`,
      trust: "operator",
    });
    const result = await act({
      action: "recall",
      query: token,
      kind: "episode",
    });
    expect(result.rows).toEqual([
      `#${episode.id} [episode] ${subject}: ${token} as an episode`,
    ]);
  });

  it("caps the limit at 20", async () => {
    const result = await act({
      action: "recall",
      query: "anything at all",
      limit: 500,
    });
    expect(result.ok).toBe(true);
    expect((result.rows as string[]).length).toBeLessThanOrEqual(20);
  });

  it("says so when nothing matches", async () => {
    const result = await act({
      action: "recall",
      query: `nothingmatchesthis${freshSubject()}`,
    });
    expect(result).toEqual({
      ok: true,
      rows: [],
      note: "nothing stored matches",
    });
  });

  it("rejects a missing query and an unknown kind", async () => {
    expect(await act({ action: "recall" })).toEqual({
      ok: false,
      error: "Missing query",
    });
    const badKind = await act({ action: "recall", query: "x", kind: "vibes" });
    expect(badKind.ok).toBe(false);
    expect(badKind.error).toContain('Unknown kind "vibes"');
  });
});

describe("forget", () => {
  it("drops a row to the graveyard with its reason", async () => {
    const subject = freshSubject();
    const { id } = assertMemory({
      kind: "fact",
      subject,
      text: "wrong from the start",
      trust: "agent",
    });
    const result = await act({
      action: "forget",
      id,
      reason: "the user said it was never true",
    });
    expect(result.ok).toBe(true);
    // Graveyard, not oblivion: still readable by id, gone from the listing.
    expect(getMemory(id)!.droppedAt).toBeGreaterThan(0);
    expect(getMemory(id)!.text).toBe("wrong from the start");
    expect(liveRows(subject)).toHaveLength(0);
  });

  it("requires a non-empty reason", async () => {
    const { id } = assertMemory({
      kind: "fact",
      subject: freshSubject(),
      text: "still true",
      trust: "agent",
    });
    const result = await act({ action: "forget", id, reason: "   " });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("reason is required");
    expect(getMemory(id)!.droppedAt).toBeUndefined();
  });

  it("refuses to forget a row a group chat did not earn", async () => {
    const subject = freshSubject();
    const dmClaim = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "learned in a private conversation",
    });
    const refused = await act(
      { action: "forget", id: dmClaim.id, reason: "do not like it" },
      GROUP_CHAT,
    );
    expect(refused).toEqual({
      ok: false,
      error: `Memory #${dmClaim.id} was recorded at agent trust; a group_chat context cannot forget it`,
    });
    expect(getMemory(dmClaim.id as number)!.droppedAt).toBeUndefined();
  });

  it("refuses to forget an operator memory from any chat", async () => {
    const subject = freshSubject();
    const { id } = assertMemory({
      kind: "directive",
      subject,
      text: "never post on my behalf",
      trust: "operator",
    });
    const refused = await act({ action: "forget", id, reason: "stale" });
    expect(refused).toEqual({
      ok: false,
      error: `Memory #${id} is an operator memory — only the operator can forget it (talon memory forget ${id})`,
    });
    expect(getMemory(id)!.droppedAt).toBeUndefined();
  });

  it("lets a group chat forget what the group itself recorded", async () => {
    const subject = freshSubject();
    const groupClaim = await act(
      { action: "remember", kind: "fact", subject, text: "said in here" },
      GROUP_CHAT,
    );
    expect(getMemory(groupClaim.id as number)!.trust).toBe("group_chat");
    const dropped = await act(
      { action: "forget", id: groupClaim.id, reason: "was a joke" },
      GROUP_CHAT,
    );
    expect(dropped.ok).toBe(true);
    expect(getMemory(groupClaim.id as number)!.droppedAt).toBeGreaterThan(0);
  });

  it("surfaces store errors as { ok: false, error }", async () => {
    const unknown = await act({
      action: "forget",
      id: 987_654_321,
      reason: "cleanup",
    });
    expect(unknown).toEqual({
      ok: false,
      error: "No memory with id 987654321",
    });

    const { id } = assertMemory({
      kind: "fact",
      subject: freshSubject(),
      text: "drop me twice",
      trust: "agent",
    });
    await act({ action: "forget", id, reason: "first drop" });
    const twice = await act({ action: "forget", id, reason: "second drop" });
    expect(twice.ok).toBe(false);
    expect(twice.error).toContain("is dropped");

    const bad = await act({ action: "forget", id: 0, reason: "cleanup" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Invalid id "0"');
  });
});

describe("the prompt-cache invariant (plan §3.6)", () => {
  it("no memory action ever invalidates the cached system prompt", async () => {
    notifyPromptInputsChanged.mockClear();
    const subject = freshSubject();
    const stored = await act({
      action: "remember",
      kind: "fact",
      subject,
      text: "a claim learned mid-session",
    });
    await act({
      action: "remember",
      kind: "directive",
      subject,
      text: "be terse",
    });
    await act({ action: "recall", query: "mid-session" });
    await act({ action: "forget", id: stored.id, reason: "test cleanup" });
    expect(notifyPromptInputsChanged).not.toHaveBeenCalled();
  });
});

describe("the tool definitions", () => {
  it("map onto the gateway actions", async () => {
    for (const name of ["remember", "recall", "forget"]) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(tool, `${name} is registered`).toBeDefined();
      expect(tool!.tag).toBe("memory");
      const bridge = vi.fn(async () => ({ ok: true }));
      await tool!.execute({ x: 1 }, bridge);
      expect(bridge).toHaveBeenCalledWith(name, { x: 1 });
      // Every action the tools name is one the shared registry answers.
      expect(await handleSharedAction({ action: name }, 1)).not.toBeNull();
    }
  });

  it("offer exactly the store's kinds", () => {
    const remember = ALL_TOOLS.find((t) => t.name === "remember")!;
    const kind = remember.schema.kind as unknown as {
      options: readonly string[];
    };
    expect([...kind.options]).toEqual([...MEMORY_KINDS]);
  });
});
