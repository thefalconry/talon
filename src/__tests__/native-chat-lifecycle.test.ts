/**
 * Chat lifecycle on the native bridge: create / rename / delete, the reset
 * that empties a conversation without removing the chat, and the sweeper
 * that reaps "New chat" rows nobody ever used.
 *
 * All three report what they did by broadcasting, so the assertions are on
 * the recording sink plus the registry and the (per-worker, throwaway)
 * SQLite stores the modules write through. The backend controller is
 * stubbed: reset warms a fresh session through it, and no pool is bound in
 * a unit test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/engine/backend-controller/index.js", () => ({
  getBackendForChat: vi.fn(() => null),
  getBackendIdForChat: vi.fn(() => {
    throw new Error("backend pool not bound");
  }),
}));

import { getBackendForChat } from "../core/engine/backend-controller/index.js";
import { logError } from "../util/log.js";
import {
  createChat,
  deleteChat,
  renameChat,
} from "../frontend/native/chats/chat-lifecycle.js";
import { startEmptyChatSweep } from "../frontend/native/chats/empty-chat-sweep.js";
import { resetChat } from "../frontend/native/chats/reset.js";
import {
  recordTurnMeta,
  getTurnMeta,
} from "../frontend/native/turn/turn-meta.js";
import {
  getHistoryStats,
  getRecentHistory,
  isChatHistoryHidden,
  pushMessage,
  searchHistoryMessages,
} from "../storage/history.js";
import { historyPage } from "../frontend/native/chats/history.js";
import { BOT_SENDER_ID } from "../frontend/native/protocol.js";
import { makeNativeHarness } from "./helpers/native-bridge.js";

const HOUR_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 30 * 60_000;

let harness: ReturnType<typeof makeNativeHarness>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBackendForChat).mockReturnValue(null as never);
  harness = makeNativeHarness();
});

describe("native chat lifecycle", () => {
  it("broadcasts a new chat in its wire shape", () => {
    const { runtime, eventsOf } = harness;
    const chat = createChat(runtime, "Roadmap");

    expect(eventsOf("chat_created")).toEqual([{ kind: "chat_created", chat }]);
    expect(chat).toMatchObject({ title: "Roadmap", preview: "" });
  });

  it("registers the new chat under both its ids", () => {
    const { runtime } = harness;
    const chat = createChat(runtime);
    const entry = runtime.chats.get(chat.id)!;

    expect(entry.title).toBe("New chat");
    expect(runtime.chats.byNumeric(entry.numericId)).toBe(entry);
  });

  it("renames a chat and syncs the new title to clients", () => {
    const { runtime, eventsOf } = harness;
    const chat = createChat(runtime);
    const renamed = renameChat(runtime, chat.id, "  Grocery list  ");

    expect(renamed).toMatchObject({ id: chat.id, title: "Grocery list" });
    expect(eventsOf("chat_updated")).toMatchObject([
      { chat: { id: chat.id, title: "Grocery list" } },
    ]);
  });

  it("keeps the existing title when the rename is blank", () => {
    const { runtime } = harness;
    const chat = createChat(runtime, "Keep me");
    expect(renameChat(runtime, chat.id, "   ")).toMatchObject({
      title: "Keep me",
    });
  });

  it("reports a rename of an unknown chat as null, with nothing broadcast", () => {
    const { runtime, events } = harness;
    expect(renameChat(runtime, "d_missing", "nope")).toBeNull();
    expect(events).toHaveLength(0);
  });

  it("deletes a chat and tells every client it is gone", () => {
    const { runtime, eventsOf } = harness;
    const chat = createChat(runtime);

    expect(deleteChat(runtime, chat.id)).toBe(true);
    expect(eventsOf("chat_deleted")).toEqual([
      { kind: "chat_deleted", chatId: chat.id },
    ]);
    expect(runtime.chats.get(chat.id)).toBeUndefined();
  });

  it("drops the deleted chat's cached readout and queue, keeps its turn meta", () => {
    const { runtime } = harness;
    const chat = createChat(runtime);
    runtime.contextByChat.set(chat.id, {
      known: true,
      used: 1,
      max: 2,
      pct: 50,
      warn: false,
    });
    runtime.queuedByChat.set(chat.id, { text: "later", attachments: [] });
    recordTurnMeta(chat.id, "9", { durationMs: 1 });

    deleteChat(runtime, chat.id);

    expect(runtime.contextByChat.has(chat.id)).toBe(false);
    expect(runtime.queuedByChat.has(chat.id)).toBe(false);
    // Kept with the (hidden) rows — only `talon history purge` drops it.
    expect(getTurnMeta(chat.id, "9")).toEqual({ durationMs: 1 });
  });

  it("soft-deletes: the chat is hidden, its history rows are kept", () => {
    const { runtime } = harness;
    const chat = createChat(runtime);
    pushMessage(chat.id, {
      msgId: 1,
      senderId: 1,
      senderName: "Ada",
      text: "a conversation worth keeping",
      timestamp: Date.now(),
    });

    expect(deleteChat(runtime, chat.id)).toBe(true);

    expect(isChatHistoryHidden(chat.id)).toBe(true);
    expect(getHistoryStats(chat.id).totalMessages).toBe(1);
    expect(
      getRecentHistory(chat.id, 10, { includeCleared: true })[0].text,
    ).toBe("a conversation worth keeping");
    // Not in the chat's context any more, and no longer restored.
    expect(getRecentHistory(chat.id, 10)).toEqual([]);
  });

  it("reports a delete of an unknown chat as false, with nothing broadcast", () => {
    const { runtime, events } = harness;
    expect(deleteChat(runtime, "d_missing")).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe("native chat reset", () => {
  it("refuses to reset a chat the registry does not know", () => {
    const { runtime, events } = harness;
    expect(resetChat(runtime, "d_missing")).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("starts the transcript fresh but keeps every history row", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    pushMessage(entry.id, {
      msgId: 1,
      senderId: BOT_SENDER_ID,
      senderName: "Talon",
      text: "old reply",
      timestamp: Date.now(),
    });

    expect(resetChat(runtime, entry.id)).toBe(true);
    expect(getRecentHistory(entry.id, 10)).toHaveLength(0);
    expect(historyPage(runtime, entry.id)).toHaveLength(0);
    // Soft reset: the row is still stored and still found by search.
    expect(getHistoryStats(entry.id).totalMessages).toBe(1);
    expect(searchHistoryMessages(entry.id, "old reply")).toHaveLength(1);
  });

  it("forgets the cached readout and queued follow-up, keeps turn meta", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    recordTurnMeta(entry.id, "3", { durationMs: 5 });
    runtime.contextByChat.set(entry.id, {
      known: true,
      used: 1,
      max: 2,
      pct: 50,
      warn: false,
    });
    runtime.queuedByChat.set(entry.id, { text: "later", attachments: [] });

    resetChat(runtime, entry.id);

    expect(getTurnMeta(entry.id, "3")).toEqual({ durationMs: 5 });
    expect(runtime.contextByChat.has(entry.id)).toBe(false);
    expect(runtime.queuedByChat.has(entry.id)).toBe(false);
  });

  it("tells the chat it was reset with a transient system message", () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    resetChat(runtime, entry.id);

    expect(eventsOf("message")).toMatchObject([
      {
        chatId: entry.id,
        message: {
          role: "system",
          text: "Session reset — starting a fresh conversation.",
        },
      },
    ]);
  });

  it("syncs the emptied chat to every client", () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    resetChat(runtime, entry.id);

    expect(eventsOf("chat_updated")).toMatchObject([
      { chat: { id: entry.id } },
    ]);
  });

  it("drops the backend's own session state and warms a fresh one", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    const backendReset = vi.fn();
    const warmSession = vi.fn(async () => {});
    vi.mocked(getBackendForChat).mockReturnValue({
      sessions: { resetChat: backendReset, warmSession },
    } as never);

    resetChat(runtime, entry.id);

    expect(backendReset).toHaveBeenCalledWith(entry.id);
    expect(warmSession).toHaveBeenCalledWith(entry.id);
  });

  it("swallows a warm that rejects — the reset itself still succeeded", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    vi.mocked(getBackendForChat).mockReturnValue({
      sessions: {
        resetChat: vi.fn(),
        warmSession: vi.fn(async () => {
          throw new Error("backend down");
        }),
      },
    } as never);

    expect(resetChat(runtime, entry.id)).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("resets a chat with no backend binding at all", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    vi.mocked(getBackendForChat).mockImplementation(() => {
      throw new Error("no pool binding");
    });

    expect(resetChat(runtime, entry.id)).toBe(true);
  });
});

describe("native empty-chat sweep", () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  /** A chat created `ageMs` ago that never carried a message. */
  function abandoned(ageMs: number) {
    const entry = harness.runtime.chats.create();
    entry.createdAt = Date.now() - ageMs;
    return entry;
  }

  it("reaps an empty chat once it is older than an hour", () => {
    const { runtime, eventsOf } = harness;
    const entry = abandoned(2 * HOUR_MS);
    stop = startEmptyChatSweep(runtime);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(eventsOf("chat_deleted")).toEqual([
      { kind: "chat_deleted", chatId: entry.id },
    ]);
  });

  it("leaves an empty chat inside the grace period alone", () => {
    const { runtime, eventsOf } = harness;
    abandoned(5 * 60_000);
    stop = startEmptyChatSweep(runtime);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(eventsOf("chat_deleted")).toHaveLength(0);
  });

  it("never reaps a chat that has carried a message", () => {
    const { runtime, eventsOf } = harness;
    const entry = abandoned(2 * HOUR_MS);
    runtime.chats.touch(entry.id, "a real message");
    stop = startEmptyChatSweep(runtime);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(eventsOf("chat_deleted")).toHaveLength(0);
  });

  it("never reaps the chat a turn is running in", () => {
    const { runtime, eventsOf } = harness;
    const entry = abandoned(2 * HOUR_MS);
    runtime.liveTurns.set(entry.id, new Map());
    stop = startEmptyChatSweep(runtime);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(eventsOf("chat_deleted")).toHaveLength(0);
  });

  it("never reaps a chat holding a queued follow-up", () => {
    const { runtime, eventsOf } = harness;
    const entry = abandoned(2 * HOUR_MS);
    runtime.queuedByChat.set(entry.id, { text: "later", attachments: [] });
    stop = startEmptyChatSweep(runtime);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(eventsOf("chat_deleted")).toHaveLength(0);
  });

  it("never reaps a chat whose stored history says otherwise", () => {
    const { runtime, eventsOf } = harness;
    const entry = abandoned(2 * HOUR_MS);
    pushMessage(entry.id, {
      msgId: 1,
      senderId: BOT_SENDER_ID,
      senderName: "Talon",
      text: "there was a conversation here",
      timestamp: Date.now(),
    });
    stop = startEmptyChatSweep(runtime);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);

    expect(eventsOf("chat_deleted")).toHaveLength(0);
  });

  it("stops sweeping once its stop function is called", () => {
    const { runtime, eventsOf } = harness;
    abandoned(2 * HOUR_MS);
    startEmptyChatSweep(runtime)();
    vi.advanceTimersByTime(4 * SWEEP_INTERVAL_MS);

    expect(eventsOf("chat_deleted")).toHaveLength(0);
  });

  it("logs a failing sweep rather than letting it escape the timer", () => {
    const { runtime } = harness;
    vi.spyOn(runtime.chats, "unused").mockImplementation(() => {
      throw new Error("registry exploded");
    });
    stop = startEmptyChatSweep(runtime);

    expect(() => vi.advanceTimersByTime(SWEEP_INTERVAL_MS)).not.toThrow();
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "native",
      "Empty-chat sweep failed",
      expect.any(Error),
    );
  });
});
