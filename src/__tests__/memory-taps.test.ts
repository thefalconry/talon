/**
 * Message taps — the memory store's mechanical input stream
 * (docs/memory-persona-plan.md §2, rollout PR 7).
 *
 * Four properties are load-bearing and each has a case here:
 *
 *   - **The regexes stay tight.** A false positive writes a claim about
 *     how Talon should behave, so the classifiers favour precision.
 *   - **Trust comes from the chat.** A DM is the operator typing, so the
 *     row is `operator` trust; a group is `group_chat`, and a *directive*
 *     is not recorded from one at all.
 *   - **A repeated phrase is one row.** The near-duplicate probe runs
 *     before every write.
 *   - **It never touches the prompt cache, and never fails a turn.** The
 *     tap must not reach `notifyPromptInputsChanged` (plan §3.6), and a
 *     store error costs one warning, not the turn.
 *
 * Plus the seam itself: the tap now runs in `dispatcher.execute`, so
 * every frontend feeds it — and only `source: "message"` does.
 *
 * The worker-shared SQLite database persists across test files and the
 * tap files every directive under one subject, so the cases here assert
 * on the rows they wrote (matched by their own unique marker text)
 * rather than on the whole subject.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Every spy is hoisted: a `vi.mock` factory runs before the module body,
// and `storage/db.ts` reaches for the logger during its own import.
const spies = vi.hoisted(() => ({
  notifyPromptInputsChanged: vi.fn(),
  logWarn: vi.fn(),
  recordMessageSignal: vi.fn(),
  /** Set to make `assertMemory` throw; null means the real store. */
  assertOverride: null as null | (() => never),
}));

// The cache invariant (plan §3.6): a memory write that invalidated every
// live session's prompt snapshot turns a ~50-token claim into a 60–90 k
// cache write. The spy below is asserted to stay untouched.
vi.mock("../core/prompt/invalidation.js", () => ({
  notifyPromptInputsChanged: spies.notifyPromptInputsChanged,
  onPromptInputsChanged: vi.fn(),
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: spies.logWarn,
  logDebug: vi.fn(),
}));

// The store stays real — only `assertMemory` is swappable, so the
// fail-closed case can make it throw without faking the rest.
vi.mock("../storage/memory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/memory.js")>();
  return {
    ...actual,
    assertMemory: (input: Parameters<typeof actual.assertMemory>[0]) =>
      spies.assertOverride
        ? spies.assertOverride()
        : actual.assertMemory(input),
  };
});

// The real tap, wrapped so the dispatcher cases can count calls.
vi.mock("../core/memory/taps.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../core/memory/taps.js")>();
  spies.recordMessageSignal.mockImplementation(actual.recordMessageSignal);
  return { ...actual, recordMessageSignal: spies.recordMessageSignal };
});

import {
  classifyMessage,
  recordMessageSignal as tap,
} from "../core/memory/taps.js";
import * as store from "../storage/memory.js";
import { execute, initDispatcher } from "../core/engine/dispatcher.js";
import {
  stubChatBackend,
  stubResolveActiveModel,
} from "./helpers/stub-backend.js";
import type { ContextManager } from "../core/types.js";

/** A positive Telegram id — `chatScope` reads it as a DM. */
const DM_CHAT = "424242420";
/** A Telegram supergroup: negative id. */
const GROUP_CHAT = "-1009876543210";

let seq = 0;
/** A marker unique to one case, so its rows are findable by text. */
function marker(): string {
  return `taptest${++seq}x${Date.now()}`;
}

function live(kind: store.MemoryKind, needle: string): store.MemoryRow[] {
  return store
    .listMemories({ kind, limit: 500 })
    .filter((row) => row.text.includes(needle));
}

beforeEach(() => {
  spies.assertOverride = null;
  spies.logWarn.mockClear();
  spies.notifyPromptInputsChanged.mockClear();
  spies.recordMessageSignal.mockClear();
});

describe("classifyMessage", () => {
  it("recognises standing instructions as directives", () => {
    for (const text of [
      "from now on, use ripgrep",
      "Going forward, keep replies short",
      "in future, check CI first",
      "you should always run the tests",
      "never use emoji in commit messages",
      "I want you to ask before pushing",
      "make sure you rebase first",
      "remember to close the PR",
    ])
      expect(classifyMessage(text)).toBe("directive");
  });

  it("recognises pushback as a correction", () => {
    for (const text of [
      "no, that is not the file I meant",
      "that's wrong",
      "you're wrong about the ordering",
      "not what I asked",
      "never do that again",
      "stop doing that",
      "wrong, try the other branch",
      "you messed that up",
    ])
      expect(classifyMessage(text)).toBe("correction");
  });

  it("leaves ordinary chat alone", () => {
    for (const text of [
      "",
      "   ",
      "what's the status of the build?",
      "thanks, that worked",
      "the wrongness of the API is well documented",
      "nobody knows",
      "I always forget which branch this is",
      // Long messages are pasted context, not standing intent.
      `from now on ${"x".repeat(600)}`,
    ])
      expect(classifyMessage(text)).toBeNull();
  });

  it("prefers correction when a message reads as both", () => {
    expect(classifyMessage("no, from now on use ripgrep")).toBe("correction");
  });
});

describe("recordMessageSignal", () => {
  it("stores a DM directive at operator trust", () => {
    const m = marker();
    expect(tap({ text: `from now on use ${m}`, chatKey: DM_CHAT })).toBe(
      "directive",
    );
    const rows = live("directive", m);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe("operator");
    expect(rows[0]!.trust).toBe("operator");
    expect(rows[0]!.text).toBe(`from now on use ${m}`);
    expect(rows[0]!.source).toEqual({ chat: DM_CHAT, actor: "tap" });
  });

  it("classifies a group directive but refuses to record it", () => {
    const m = marker();
    expect(tap({ text: `from now on use ${m}`, chatKey: GROUP_CHAT })).toBe(
      "directive",
    );
    expect(live("directive", m)).toHaveLength(0);
  });

  it("stores a correction as an episode, at the chat's trust", () => {
    const dm = marker();
    expect(
      tap({ text: `no, that's wrong about ${dm}`, chatKey: DM_CHAT }),
    ).toBe("correction");
    const dmRows = live("episode", dm);
    expect(dmRows).toHaveLength(1);
    expect(dmRows[0]!.subject).toBe("correction");
    expect(dmRows[0]!.trust).toBe("operator");

    const group = marker();
    tap({ text: `no, that's wrong about ${group}`, chatKey: GROUP_CHAT });
    const groupRows = live("episode", group);
    expect(groupRows).toHaveLength(1);
    expect(groupRows[0]!.trust).toBe("group_chat");
  });

  it("does not store a second row for the same phrase said twice", () => {
    const m = marker();
    const text = `from now on always use ${m} for search`;
    tap({ text, chatKey: DM_CHAT });
    tap({ text, chatKey: DM_CHAT });
    tap({ text: `  ${text}  `, chatKey: DM_CHAT });
    expect(live("directive", m)).toHaveLength(1);
  });

  it("still stores a genuinely different directive", () => {
    const a = marker();
    const b = marker();
    tap({ text: `from now on always use ${a} for search`, chatKey: DM_CHAT });
    tap({ text: `from now on never open ${b} in a group`, chatKey: DM_CHAT });
    expect(live("directive", a)).toHaveLength(1);
    expect(live("directive", b)).toHaveLength(1);
  });

  it("returns null and writes nothing for ordinary chat", () => {
    const m = marker();
    expect(tap({ text: `how is ${m} doing?`, chatKey: DM_CHAT })).toBeNull();
    expect(live("directive", m)).toHaveLength(0);
    expect(live("episode", m)).toHaveLength(0);
  });

  it("fails closed: a store error is one warning, and the class survives", () => {
    spies.assertOverride = () => {
      throw new Error("database is locked");
    };
    const m = marker();
    expect(tap({ text: `from now on use ${m}`, chatKey: DM_CHAT })).toBe(
      "directive",
    );
    expect(spies.logWarn).toHaveBeenCalledTimes(1);
    expect(String(spies.logWarn.mock.calls[0]![1])).toContain(
      "database is locked",
    );
  });

  it("never invalidates the cached system prompt", () => {
    tap({ text: `from now on use ${marker()}`, chatKey: DM_CHAT });
    tap({ text: `no, that's wrong about ${marker()}`, chatKey: DM_CHAT });
    expect(spies.notifyPromptInputsChanged).not.toHaveBeenCalled();
  });
});

describe("the engine seam — every frontend feeds the tap", () => {
  beforeEach(() => {
    const { backend } = stubChatBackend({ text: "response" });
    const context: ContextManager = {
      acquire: vi.fn(),
      release: vi.fn(),
      getMessageCount: vi.fn(() => 0),
    };
    initDispatcher({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context,
      sendTyping: vi.fn(async () => {}),
    });
    spies.recordMessageSignal.mockClear();
  });

  it("taps an inbound message, and lands the row", async () => {
    const m = marker();
    await execute({
      chatId: DM_CHAT,
      numericChatId: Number(DM_CHAT),
      prompt: `from now on use ${m}`,
      senderName: "Ada",
      isGroup: false,
      source: "message",
    });
    expect(spies.recordMessageSignal).toHaveBeenCalledWith({
      text: `from now on use ${m}`,
      chatKey: DM_CHAT,
      actor: "Ada",
    });
    expect(live("directive", m)).toHaveLength(1);
  });

  it("records nothing for a directive spoken in a group", async () => {
    const m = marker();
    await execute({
      chatId: GROUP_CHAT,
      numericChatId: Number(GROUP_CHAT),
      prompt: `from now on use ${m}`,
      senderName: "Someone",
      isGroup: true,
      source: "message",
    });
    expect(spies.recordMessageSignal).toHaveBeenCalledTimes(1);
    expect(live("directive", m)).toHaveLength(0);
  });

  it("leaves Talon's own prompts alone — pulse, cron and triggers", async () => {
    for (const source of ["pulse", "cron", "trigger"] as const) {
      const m = marker();
      await execute({
        chatId: DM_CHAT,
        numericChatId: Number(DM_CHAT),
        prompt: `from now on use ${m}`,
        senderName: "Talon",
        isGroup: false,
        source,
      });
      expect(live("directive", m)).toHaveLength(0);
    }
    expect(spies.recordMessageSignal).not.toHaveBeenCalled();
  });

  it("never invalidates the cached system prompt", () => {
    expect(spies.notifyPromptInputsChanged).not.toHaveBeenCalled();
  });
});
