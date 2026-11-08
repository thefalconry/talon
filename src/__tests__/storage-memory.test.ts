/**
 * Typed memory store — the row lifecycle (assert / supersede / drop /
 * merge / pin), keyed-state replacement, FTS5 retrieval and validation,
 * against the real (per-worker throwaway) SQLite database.
 *
 * The database is shared across the tests in this file, so every case
 * works under its own unique subject / state-key prefix.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  assertMemory,
  dropMemory,
  findSimilarMemories,
  formatMemory,
  getMemory,
  listMemories,
  memoryHistory,
  mergeMemory,
  pinMemory,
  replaceStateKey,
  searchMemories,
  supersedeMemory,
  touchMemory,
  unpinMemory,
  MAX_SUBJECT_LENGTH,
  MAX_TEXT_LENGTH,
  type MemoryInput,
  type MemoryTrust,
} from "../storage/memory.js";

let seq = 0;
/** Unique subject per test — the worker-shared DB persists across tests. */
function freshSubject(): string {
  return `mem-test-${++seq}-${Date.now()}`;
}

function input(overrides: Partial<MemoryInput> = {}): MemoryInput {
  return {
    kind: "fact",
    subject: "mem-test-default",
    text: "Ada ships on Fridays",
    trust: "operator",
    ...overrides,
  };
}

describe("memory store CRUD", () => {
  let subject: string;
  beforeEach(() => {
    subject = freshSubject();
  });

  it("round-trips a row with every field set", () => {
    const { id } = assertMemory({
      kind: "relationship",
      subject,
      text: "  Prefers terse answers  ",
      trust: "agent",
      confidence: 0.4,
      salience: 2.5,
      source: { frontend: "telegram", chat: "c1", actor: "u1", turn: "t1" },
    });
    const row = getMemory(id)!;
    expect(row.kind).toBe("relationship");
    expect(row.subject).toBe(subject);
    // Text is trimmed on the way in.
    expect(row.text).toBe("Prefers terse answers");
    expect(row.trust).toBe("agent");
    expect(row.confidence).toBe(0.4);
    expect(row.salience).toBe(2.5);
    expect(row.source).toEqual({
      frontend: "telegram",
      chat: "c1",
      actor: "u1",
      turn: "t1",
    });
    expect(row.pinned).toBe(false);
    expect(row.hitCount).toBe(0);
    expect(row.supersededBy).toBeUndefined();
    expect(row.droppedAt).toBeUndefined();
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns undefined for unknown ids", () => {
    expect(getMemory(-1)).toBeUndefined();
  });

  it("opens the audit trail with an assert entry", () => {
    const { id } = assertMemory(input({ subject }));
    const history = memoryHistory(id);
    expect(history).toHaveLength(1);
    expect(history[0]!.op).toBe("assert");
    expect(history[0]!.afterText).toBe("Ada ships on Fridays");
  });

  it("lists live rows pinned first", () => {
    const plain = assertMemory(input({ subject, text: "plain claim" })).id;
    const special = assertMemory(input({ subject, text: "pinned claim" })).id;
    pinMemory(special);
    const rows = listMemories({ subject });
    expect(rows.map((r) => r.id)).toEqual([special, plain]);
  });

  it("honours the kind filter and the limit", () => {
    assertMemory(input({ subject, kind: "fact", text: "a fact" }));
    assertMemory(input({ subject, kind: "episode", text: "an episode" }));
    expect(
      listMemories({ subject, kind: "episode" }).map((r) => r.text),
    ).toEqual(["an episode"]);
    expect(listMemories({ subject, limit: 1 })).toHaveLength(1);
  });

  it("touch bumps the hit count without auditing the hit", () => {
    const { id } = assertMemory(input({ subject }));
    const before = memoryHistory(id).length;
    touchMemory(id);
    touchMemory(id);
    expect(getMemory(id)!.hitCount).toBe(2);
    expect(getMemory(id)!.lastSeenAt).toBeGreaterThan(0);
    // A touch changes no content, so it writes no history row.
    expect(memoryHistory(id)).toHaveLength(before);
  });

  it("formats a row as one line with its markers", () => {
    const { id } = assertMemory(input({ subject, text: "one liner" }));
    pinMemory(id);
    expect(formatMemory(getMemory(id)!)).toBe(
      `#${id} [fact] ${subject}: one liner (pinned)`,
    );
  });
});

describe("memory search", () => {
  let subject: string;
  beforeEach(() => {
    subject = freshSubject();
  });

  it("finds rows by full-text match", () => {
    const { id } = assertMemory(
      input({ subject, text: "the espresso machine needs descaling" }),
    );
    const hits = searchMemories("espresso", { limit: 50 });
    expect(hits.map((r) => r.id)).toContain(id);
  });

  it("filters search by kind", () => {
    const token = `tok${seq}xyz`;
    assertMemory(input({ subject, kind: "fact", text: `fact ${token}` }));
    const episode = assertMemory(
      input({ subject, kind: "episode", text: `episode ${token}` }),
    );
    const hits = searchMemories(token, { kind: "episode", limit: 50 });
    expect(hits.map((r) => r.id)).toEqual([episode.id]);
  });

  it("treats quotes and FTS operators in a query as literal text", () => {
    assertMemory(input({ subject, text: 'he said "ship it" AND left' }));
    for (const query of ['"ship it"', "AND OR NOT", "foo* ^bar", '""']) {
      expect(() => searchMemories(query)).not.toThrow();
    }
    expect(searchMemories("")).toEqual([]);
  });

  it("hides superseded and dropped rows from search", () => {
    const token = `hidden${seq}tok`;
    const { id } = assertMemory(input({ subject, text: `secret ${token}` }));
    supersedeMemory(id, `replacement ${token}`, "restated");
    const hits = searchMemories(token, { limit: 50 });
    expect(hits.map((r) => r.id)).not.toContain(id);
    dropMemory(hits[0]!.id, "done");
    expect(searchMemories(token, { limit: 50 })).toEqual([]);
  });

  it("reports live near-duplicates on assert without superseding", () => {
    const first = assertMemory(
      input({ subject, text: "the release ships on Friday" }),
    );
    expect(first.similar).toEqual([]);
    const second = assertMemory(
      input({ subject, text: "the release ships on Friday afternoon" }),
    );
    expect(second.similar.map((r) => r.id)).toContain(first.id);
    // Nothing was auto-superseded — both rows are still live.
    expect(getMemory(first.id)!.supersededBy).toBeUndefined();
    expect(listMemories({ subject })).toHaveLength(2);
  });

  it("does not offer near-duplicates from another subject", () => {
    const other = freshSubject();
    assertMemory(input({ subject: other, text: "shared wording here" }));
    const { similar } = assertMemory(
      input({ subject, text: "shared wording here" }),
    );
    expect(similar).toEqual([]);
  });

  // ── findSimilarMemories: the same probe, without writing ───────────────

  it("findSimilarMemories runs the probe without inserting anything", () => {
    const { id } = assertMemory(
      input({ subject, text: "the release ships on Friday" }),
    );
    const similar = findSimilarMemories(
      "fact",
      subject,
      "the release ships on Friday afternoon",
    );
    expect(similar.map((r) => r.id)).toEqual([id]);
    // The probe is a read: only the original row exists.
    expect(listMemories({ subject })).toHaveLength(1);
  });

  it("findSimilarMemories scopes to the same kind and subject", () => {
    const other = freshSubject();
    assertMemory(input({ subject, text: "distinctive wording here" }));
    expect(
      findSimilarMemories("fact", other, "distinctive wording here"),
    ).toEqual([]);
    expect(
      findSimilarMemories("episode", subject, "distinctive wording here"),
    ).toEqual([]);
  });

  it("findSimilarMemories skips superseded and dropped rows", () => {
    const { id } = assertMemory(input({ subject, text: "moved to Lisbon" }));
    expect(
      findSimilarMemories("fact", subject, "moved to Lisbon"),
    ).toHaveLength(1);
    dropMemory(id, "wrong");
    expect(findSimilarMemories("fact", subject, "moved to Lisbon")).toEqual([]);
  });

  it("findSimilarMemories returns nothing for text with no usable terms", () => {
    assertMemory(input({ subject, text: "some real words" }));
    expect(findSimilarMemories("fact", subject, "?? !! ??")).toEqual([]);
  });

  it("findSimilarMemories honours its limit", () => {
    for (let i = 0; i < 4; i++)
      assertMemory(input({ subject, text: `recurring phrase variant ${i}` }));
    expect(
      findSimilarMemories("fact", subject, "recurring phrase", 2),
    ).toHaveLength(2);
  });
});

describe("supersede", () => {
  let subject: string;
  beforeEach(() => {
    subject = freshSubject();
  });

  it("replaces a row, keeps the old one readable and links them", () => {
    const { id } = assertMemory(
      input({ subject, text: "Ada lives in London", salience: 3 }),
    );
    pinMemory(id);
    const newId = supersedeMemory(id, "Ada lives in Lisbon", "he moved");
    const old = getMemory(id)!;
    const next = getMemory(newId)!;
    expect(old.supersededBy).toBe(newId);
    expect(next.text).toBe("Ada lives in Lisbon");
    // The successor inherits the old row's frame.
    expect(next.kind).toBe(old.kind);
    expect(next.subject).toBe(old.subject);
    expect(next.trust).toBe(old.trust);
    expect(next.pinned).toBe(true);
    expect(next.salience).toBe(3);
  });

  it("hides the old row from listings", () => {
    const { id } = assertMemory(input({ subject, text: "old" }));
    const newId = supersedeMemory(id, "new", "restated");
    expect(listMemories({ subject }).map((r) => r.id)).toEqual([newId]);
    expect(
      listMemories({ subject, includeSuperseded: true }).map((r) => r.id),
    ).toContain(id);
  });

  it("writes a supersede entry with the reason", () => {
    const { id } = assertMemory(input({ subject, text: "old" }));
    supersedeMemory(id, "new", "he moved");
    const entry = memoryHistory(id).find((e) => e.op === "supersede")!;
    expect(entry.beforeText).toBe("old");
    expect(entry.afterText).toBe("new");
    expect(entry.reason).toBe("he moved");
  });

  it("refuses to supersede a dropped row", () => {
    const { id } = assertMemory(input({ subject }));
    dropMemory(id, "wrong");
    expect(() => supersedeMemory(id, "next")).toThrow(/dropped/);
  });

  it("keeps the chain linear: a superseded row cannot be changed again", () => {
    const { id } = assertMemory(input({ subject, text: "first" }));
    const second = supersedeMemory(id, "second", "restated");
    expect(() => supersedeMemory(id, "fork", "second try")).toThrow(
      new RegExp(`superseded by #${second}`),
    );
    for (const mutate of [
      () => dropMemory(id, "late"),
      () => mergeMemory([id], "folded"),
      () => pinMemory(id),
      () => unpinMemory(id),
      () => touchMemory(id),
    ]) {
      expect(mutate).toThrow(/is superseded by/);
    }
    // The successor is untouched by the refused writes.
    expect(getMemory(second)!.text).toBe("second");
    expect(getMemory(id)!.supersededBy).toBe(second);
  });

  it("refuses an unknown id", () => {
    expect(() => supersedeMemory(-7, "next")).toThrow(/No memory with id/);
  });
});

describe("drop (the graveyard)", () => {
  let subject: string;
  beforeEach(() => {
    subject = freshSubject();
  });

  it("soft-deletes: the row survives by id and history keeps the reason", () => {
    const { id } = assertMemory(input({ subject, text: "obsolete" }));
    dropMemory(id, "no longer true");
    const row = getMemory(id)!;
    expect(row.droppedAt).toBeGreaterThan(0);
    expect(row.text).toBe("obsolete");
    expect(listMemories({ subject })).toEqual([]);
    expect(
      listMemories({ subject, includeDropped: true }).map((r) => r.id),
    ).toEqual([id]);
    const entry = memoryHistory(id).find((e) => e.op === "drop")!;
    expect(entry.reason).toBe("no longer true");
    expect(entry.beforeText).toBe("obsolete");
  });

  it("requires a reason to drop a pinned row", () => {
    const { id } = assertMemory(input({ subject }));
    pinMemory(id);
    expect(() => dropMemory(id)).toThrow(/pinned/);
    expect(() => dropMemory(id, "   ")).toThrow(/pinned/);
    dropMemory(id, "superseded by a directive");
    expect(getMemory(id)!.droppedAt).toBeGreaterThan(0);
  });

  it("refuses to drop twice", () => {
    const { id } = assertMemory(input({ subject }));
    dropMemory(id, "done");
    expect(() => dropMemory(id, "again")).toThrow(/dropped/);
  });
});

describe("merge", () => {
  let subject: string;
  beforeEach(() => {
    subject = freshSubject();
  });

  it("folds several rows into one and supersedes each", () => {
    const a = assertMemory(input({ subject, text: "likes tea" })).id;
    const b = assertMemory(input({ subject, text: "likes strong tea" })).id;
    const merged = mergeMemory(
      [a, b],
      "likes strong tea in the morning",
      "dup",
    );
    expect(getMemory(a)!.supersededBy).toBe(merged);
    expect(getMemory(b)!.supersededBy).toBe(merged);
    expect(listMemories({ subject }).map((r) => r.id)).toEqual([merged]);
    expect(memoryHistory(merged)[0]!.op).toBe("merge");
  });

  it("refuses to merge across kinds", () => {
    const a = assertMemory(input({ subject, kind: "fact" })).id;
    const b = assertMemory(
      input({ subject, kind: "episode", text: "something happened" }),
    ).id;
    expect(() => mergeMemory([a, b], "combined")).toThrow(/across kinds/);
    // The transaction rolled back — no survivor row, both inputs live.
    expect(getMemory(a)!.supersededBy).toBeUndefined();
    expect(getMemory(b)!.supersededBy).toBeUndefined();
    expect(
      listMemories({ subject })
        .map((r) => r.id)
        .sort(),
    ).toEqual([a, b].sort());
  });

  it("refuses an empty id list", () => {
    expect(() => mergeMemory([], "combined")).toThrow(/at least one/);
  });
});

describe("pinning", () => {
  let subject: string;
  beforeEach(() => {
    subject = freshSubject();
  });

  it("pins and unpins, recording both ops", () => {
    const { id } = assertMemory(input({ subject }));
    pinMemory(id);
    expect(getMemory(id)!.pinned).toBe(true);
    unpinMemory(id);
    expect(getMemory(id)!.pinned).toBe(false);
    expect(memoryHistory(id).map((e) => e.op)).toEqual([
      "assert",
      "pin",
      "unpin",
    ]);
  });

  it("refuses to pin a user_claim or group_chat row", () => {
    const unpinnable: readonly MemoryTrust[] = ["user_claim", "group_chat"];
    for (const trust of unpinnable) {
      const { id } = assertMemory(input({ subject, trust }));
      expect(() => pinMemory(id)).toThrow(/never be pinned/);
      expect(getMemory(id)!.pinned).toBe(false);
      expect(() =>
        assertMemory(input({ subject, trust, pinned: true })),
      ).toThrow(/never be pinned/);
    }
  });
});

describe("keyed state", () => {
  let key: string;
  beforeEach(() => {
    key = `heartbeat.health-${++seq}`;
  });

  it("keeps exactly one live row per key", () => {
    const first = replaceStateKey(key, "green");
    const second = replaceStateKey(key, "amber");
    expect(getMemory(first)!.supersededBy).toBe(second);
    const live = listMemories({ kind: "state", subject: "heartbeat" }).filter(
      (r) => r.key === key,
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(second);
    expect(live[0]!.text).toBe("amber");
  });

  it("defaults the subject to the key prefix and the trust to agent", () => {
    const id = replaceStateKey(key, "green");
    const row = getMemory(id)!;
    expect(row.subject).toBe("heartbeat");
    expect(row.kind).toBe("state");
    expect(row.trust).toBe("agent");
    expect(row.key).toBe(key);
    // A state row is labelled by its key, which carries the subject.
    expect(formatMemory(row)).toBe(`#${id} [state] ${key}: green`);
  });

  it("records replace_state on the new row and supersede on the old", () => {
    const first = replaceStateKey(key, "green");
    const second = replaceStateKey(key, "red", {}, { reason: "probe failed" });
    expect(memoryHistory(second)[0]!.op).toBe("replace_state");
    const entry = memoryHistory(first).find((e) => e.op === "supersede")!;
    expect(entry.reason).toBe("probe failed");
    expect(entry.beforeText).toBe("green");
  });

  it("accepts an explicit subject, source and confidence", () => {
    const id = replaceStateKey(
      key,
      "green",
      { frontend: "cron" },
      { subject: "ci", confidence: 0.5, salience: 1 },
    );
    const row = getMemory(id)!;
    expect(row.subject).toBe("ci");
    expect(row.source).toEqual({ frontend: "cron" });
    expect(row.confidence).toBe(0.5);
    expect(row.salience).toBe(1);
  });
});

describe("validation", () => {
  const subject = "mem-validation";

  it("rejects unknown kinds and trusts", () => {
    expect(() =>
      assertMemory(input({ subject, kind: "nonsense" as never })),
    ).toThrow(/Unknown memory kind/);
    expect(() =>
      assertMemory(input({ subject, trust: "nonsense" as never })),
    ).toThrow(/Unknown memory trust/);
  });

  it("rejects empty and oversized text", () => {
    expect(() => assertMemory(input({ subject, text: "   " }))).toThrow(
      /must not be empty/,
    );
    expect(() =>
      assertMemory(input({ subject, text: "x".repeat(MAX_TEXT_LENGTH + 1) })),
    ).toThrow(/too long/);
  });

  it("rejects empty and oversized subjects", () => {
    expect(() => assertMemory(input({ subject: "  " }))).toThrow(
      /subject must not be empty/,
    );
    expect(() =>
      assertMemory(input({ subject: "s".repeat(MAX_SUBJECT_LENGTH + 1) })),
    ).toThrow(/subject too long/);
  });

  it("rejects a confidence outside 0..1", () => {
    expect(() => assertMemory(input({ subject, confidence: 1.5 }))).toThrow(
      /between 0 and 1/,
    );
    expect(() => assertMemory(input({ subject, confidence: -0.1 }))).toThrow(
      /between 0 and 1/,
    );
  });

  it("requires a key for state and forbids one elsewhere", () => {
    expect(() => assertMemory(input({ subject, kind: "state" }))).toThrow(
      /requires a key/,
    );
    expect(() =>
      assertMemory(input({ subject, kind: "fact", key: "some.key" })),
    ).toThrow(/Only state memories carry a key/);
  });

  it("rejects malformed state keys", () => {
    for (const bad of ["Has Caps", "with space", "sym$bol", "x".repeat(101)]) {
      expect(() => replaceStateKey(bad, "value")).toThrow();
    }
  });
});
