/**
 * The memory store's **core view** — the static-prompt tier of
 * docs/memory-persona-plan.md §3.4, behind `TALON_MEMORY_STORE`.
 *
 * Three properties are load-bearing and each has a test here:
 *
 *   - **Selection, not slicing.** Pinned first, then directives, the
 *     relationship layer, facts by salience, and only *fresh* state.
 *     `episode` and `reflection` never enter (plan §3.1).
 *   - **The cache invariant.** The view lands in `staticText` and never
 *     in `dynamicText`, and the store is consulted once per build — the
 *     prompt is frozen per session, so a per-turn store read here would
 *     be both wasted work and the first step towards someone reaching
 *     for `notifyPromptInputsChanged()` (plan §3.6).
 *   - **The off path is unchanged.** With the flag unset or `0` the
 *     assembled prompt is byte-identical to today's, which is what makes
 *     shipping default-off safe.
 *
 * The worker-shared SQLite database persists across test files, so every
 * case writes under its own unique subject prefix, and the cases that
 * need to know exactly what the store holds drive `listMemories` through
 * a module mock rather than the real database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assembleSystemPrompt } from "../core/prompt/assemble.js";
import {
  CORE_VIEW_MAX_CHARS,
  renderCoreView,
  selectCoreRows,
} from "../core/memory/core-view.js";
import { memoryStoreEnabled } from "../core/memory/flag.js";
import {
  assertMemory,
  dropMemory,
  pinMemory,
  type MemoryInput,
  type MemoryRow,
} from "../storage/memory.js";

const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
/** Unique subject prefix per case — the worker-shared DB is long-lived. */
function freshPrefix(): string {
  return `core-view-${++seq}-${Date.now()}`;
}

/** Rows written by a case, dropped again so later cases see a clean store. */
const written: number[] = [];

function write(input: Partial<MemoryInput> & { subject: string }): number {
  const { id } = assertMemory({
    kind: "fact",
    text: `text for ${input.subject}`,
    trust: "operator",
    ...input,
  });
  written.push(id);
  return id;
}

/** One synthetic row, for the cases that mock the store out entirely. */
function row(overrides: Partial<MemoryRow> & { id: number }): MemoryRow {
  return {
    kind: "fact",
    subject: `subject-${overrides.id}`,
    text: `text-${overrides.id}`,
    source: {},
    trust: "operator",
    confidence: 1,
    createdAt: 1,
    lastSeenAt: 1,
    hitCount: 0,
    salience: 0.5,
    pinned: false,
    contentHash: `hash-${overrides.id}`,
    ...overrides,
  };
}

/**
 * Assemble with `listMemories` (and the prompt log) under the test's
 * control, on a fresh module graph so the "logged once" guard in
 * assemble.ts doesn't swallow the line.
 */
async function assembleWithRows(rows: MemoryRow[]): Promise<{
  parts: { staticText: string; dynamicText: string };
  calls: number;
  logged: string[];
}> {
  vi.resetModules();
  const listMemories = vi.fn(() => rows);
  const logged: string[] = [];
  vi.doMock("../storage/memory.js", () => ({ listMemories }));
  vi.doMock("../util/log.js", () => ({
    log: (_area: string, message: string) => logged.push(message),
  }));
  try {
    const mod = await import("../core/prompt/assemble.js");
    const parts = mod.assembleSystemPrompt({ frontend: "terminal" });
    return { parts, calls: listMemories.mock.calls.length, logged };
  } finally {
    vi.doUnmock("../storage/memory.js");
    vi.doUnmock("../util/log.js");
    vi.resetModules();
  }
}

beforeEach(() => {
  delete process.env.TALON_MEMORY_STORE;
});

afterEach(() => {
  delete process.env.TALON_MEMORY_STORE;
  for (const id of written.splice(0)) {
    try {
      dropMemory(id, "test cleanup");
    } catch {
      /* already gone */
    }
  }
});

describe("memoryStoreEnabled", () => {
  it("is off unless the flag is exactly 1", () => {
    expect(memoryStoreEnabled()).toBe(false);
    process.env.TALON_MEMORY_STORE = "0";
    expect(memoryStoreEnabled()).toBe(false);
    process.env.TALON_MEMORY_STORE = "true";
    expect(memoryStoreEnabled()).toBe(false);
    process.env.TALON_MEMORY_STORE = "1";
    expect(memoryStoreEnabled()).toBe(true);
  });
});

describe("selectCoreRows", () => {
  it("orders pinned first, then directive, relationship, fact", () => {
    const p = freshPrefix();
    const fact = write({ subject: `${p}-fact`, salience: 0.9 });
    const rel = write({ subject: `${p}-rel`, kind: "relationship" });
    const directive = write({ subject: `${p}-dir`, kind: "directive" });
    // Pinned, lowest-ranked kind, lowest salience — the pin is what lifts it.
    const pinned = write({ subject: `${p}-pin`, salience: 0.1 });
    pinMemory(pinned);

    const ids = selectCoreRows()
      .filter((r) => r.subject.startsWith(p))
      .map((r) => r.id);
    expect(ids).toEqual([pinned, directive, rel, fact]);
  });

  it("ranks facts by salience, then recency", () => {
    const p = freshPrefix();
    const low = write({ subject: `${p}-low`, salience: 0.2 });
    const high = write({ subject: `${p}-high`, salience: 0.95 });
    const mid = write({ subject: `${p}-mid`, salience: 0.5 });

    const ids = selectCoreRows()
      .filter((r) => r.subject.startsWith(p))
      .map((r) => r.id);
    expect(ids).toEqual([high, mid, low]);
  });

  it("never admits episode or reflection rows, pinned or not", () => {
    const p = freshPrefix();
    const episode = write({ subject: `${p}-ep`, kind: "episode" });
    const reflection = write({ subject: `${p}-refl`, kind: "reflection" });
    pinMemory(episode);

    const ids = selectCoreRows().map((r) => r.id);
    expect(ids).not.toContain(episode);
    expect(ids).not.toContain(reflection);
  });

  it("keeps fresh state and leaves stale state out", () => {
    const p = freshPrefix();
    const state = write({
      subject: `${p}-state`,
      kind: "state",
      key: `${p}.status`,
    });

    // The row was written now, so the clock moves rather than the row.
    expect(selectCoreRows().map((r) => r.id)).toContain(state);
    expect(
      selectCoreRows({ now: Date.now() + 3 * DAY }).map((r) => r.id),
    ).toContain(state);
    expect(
      selectCoreRows({ now: Date.now() + 8 * DAY }).map((r) => r.id),
    ).not.toContain(state);
  });

  it("keeps a pinned state row past the freshness window", () => {
    const p = freshPrefix();
    const id = write({ subject: `${p}-s`, kind: "state", key: `${p}.s` });
    pinMemory(id);
    const ids = selectCoreRows({ now: Date.now() + 30 * DAY }).map((r) => r.id);
    expect(ids).toContain(id);
  });

  it("stops taking rows once the budget is spent", () => {
    const p = freshPrefix();
    for (let i = 0; i < 6; i += 1) {
      write({ subject: `${p}-${i}`, text: "x".repeat(200), salience: 0.9 });
    }
    const rows = selectCoreRows({ budget: 400 }).filter((r) =>
      r.subject.startsWith(p),
    );
    expect(rows.length).toBeLessThan(6);
  });
});

describe("renderCoreView", () => {
  it("renders the selected rows and reports what it cost", () => {
    const p = freshPrefix();
    const id = write({ subject: `${p}-thing`, text: "Ada ships on Fridays" });
    pinMemory(id);
    const view = renderCoreView();
    expect(view.rows).toBeGreaterThan(0);
    expect(view.text).toContain("Ada ships on Fridays");
    expect(view.chars).toBe(view.text.length);
  });

  it("honours the budget, naming what it held back", () => {
    const p = freshPrefix();
    for (let i = 0; i < 8; i += 1) {
      write({ subject: `${p}-${i}`, text: "y".repeat(300), salience: 0.9 });
    }
    const view = renderCoreView({ budget: 900 });
    expect(view.chars).toBeLessThanOrEqual(900);
    expect(view.text).toMatch(/more sections? in the store/);
  });

  it("budgets at roughly 2k tokens by default", () => {
    expect(CORE_VIEW_MAX_CHARS).toBe(8_000);
  });
});

describe("assembleSystemPrompt with TALON_MEMORY_STORE", () => {
  it("is byte-identical to today's prompt when the flag is unset or 0", () => {
    const id = write({ subject: `${freshPrefix()}-x`, text: "store has rows" });
    pinMemory(id);

    const absent = assembleSystemPrompt({ frontend: "terminal" });
    process.env.TALON_MEMORY_STORE = "0";
    const off = assembleSystemPrompt({ frontend: "terminal" });
    delete process.env.TALON_MEMORY_STORE;
    const again = assembleSystemPrompt({ frontend: "terminal" });

    expect(off.staticText).toBe(absent.staticText);
    expect(off.dynamicText).toBe(absent.dynamicText);
    expect(again.staticText).toBe(absent.staticText);
    expect(again.dynamicText).toBe(absent.dynamicText);
    expect(absent.staticText).not.toContain("store has rows");
  });

  it("carries no soul section — the kernel is gone", () => {
    // What survives of `soul-prompt-injection.test.ts`: the soul's §1.5
    // block only ever emitted with `TALON_SOUL_ENABLED` on, which was off
    // by default, so removing it leaves the default prompt's bytes
    // untouched. This case is what would catch it coming back.
    process.env.TALON_SOUL_ENABLED = "1";
    const parts = assembleSystemPrompt({ frontend: "terminal" });
    delete process.env.TALON_SOUL_ENABLED;
    expect(parts.staticText).not.toContain("compiled identity (soul)");
    expect(parts.dynamicText).not.toContain("compiled identity (soul)");
  });

  it("puts the core view in staticText only, never in dynamicText", async () => {
    process.env.TALON_MEMORY_STORE = "1";
    const { parts } = await assembleWithRows([
      row({ id: 1, subject: "marker-subject", text: "core-view marker claim" }),
    ]);

    expect(parts.staticText).toContain("core-view marker claim");
    expect(parts.staticText).toContain("talon memory list");
    expect(parts.staticText).toContain("core view");
    expect(parts.dynamicText).not.toContain("core-view marker claim");
    expect(parts.dynamicText).not.toContain("core view");
  });

  it("reads the store exactly once per build, and logs memory(store)", async () => {
    process.env.TALON_MEMORY_STORE = "1";
    const { calls, logged } = await assembleWithRows([
      row({ id: 2, subject: "once-subject" }),
    ]);

    expect(calls).toBe(1);
    expect(logged.join(" ")).toContain("memory(store)");
  });

  it("falls back to the file path when the store is empty", async () => {
    process.env.TALON_MEMORY_STORE = "1";
    const on = await assembleWithRows([]);
    delete process.env.TALON_MEMORY_STORE;
    const off = await assembleWithRows([]);

    expect(on.parts.staticText).toBe(off.parts.staticText);
    expect(on.logged.join(" ")).not.toContain("memory(store)");
  });
});
