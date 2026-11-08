/**
 * No backend switch or reset path deletes chat history. Switches leave it
 * alone entirely; resets and admin kills move the chat's context floor
 * (a soft reset) and keep every row. Storage is the real per-worker SQLite
 * database; only the backend pool and pulse are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const outgoing = vi.hoisted(() => ({
  sessions: { resetChat: vi.fn(), warmSession: vi.fn(async () => {}) },
}));
const incoming = vi.hoisted(() => ({
  sessions: { resetChat: vi.fn(), warmSession: vi.fn(async () => {}) },
}));
const current = vi.hoisted(() => ({ id: "be-a" }));

vi.mock("../core/engine/backend-controller/index.js", () => ({
  hasBackendPool: vi.fn(() => true),
  getBackendIdForChat: vi.fn(() => current.id),
  getBackendForChat: vi.fn(() => null),
  resolveChatBackend: vi.fn(() =>
    current.id === "be-a" ? outgoing : incoming,
  ),
  listAvailableBackends: vi.fn(() => [
    { id: "be-a", label: "A" },
    { id: "be-b", label: "B" },
  ]),
  rebindChat: vi.fn(async (_chat: string, id: string) => {
    current.id = id;
    return { ok: true };
  }),
  releaseChat: vi.fn(async () => {}),
}));
vi.mock("../core/models/active-model.js", () => ({
  resolveActiveModelForChat: vi.fn(async () => ({ model: "m" })),
}));

import { handleBackendSelect } from "../frontend/discord/callbacks/components/backend-select.js";
import { handleAdminSubcommand } from "../frontend/discord/admin.js";
import {
  switchChatBackend,
  resetChatBackend,
} from "../frontend/presentation/model-commands.js";
import { performSessionReset } from "../frontend/presentation/session-status.js";
import {
  handOffChatBackend,
  resetChat,
} from "../frontend/native/chats/reset.js";
import {
  getChatHistoryState,
  getHistoryStats,
  getRecentHistory,
  pushMessage,
  searchHistory,
} from "../storage/history.js";
import { getArchivedSessions, setSessionId } from "../storage/sessions.js";
import { makeNativeHarness } from "./helpers/native-bridge.js";
import type { TalonConfig } from "../core/config/index.js";

const config = {
  backend: "be-a",
  enabledBackends: ["be-a", "be-b"],
} as unknown as TalonConfig;

let seq = 0;
function seededChat(prefix = "hnd"): string {
  const id = `${prefix}-${process.pid}-${++seq}`;
  pushMessage(id, {
    msgId: 1,
    senderId: 1,
    senderName: "Ada",
    text: "weeks of history",
    timestamp: Date.now() - 1_000,
  });
  return id;
}

function texts(id: string): string[] {
  return getRecentHistory(id, 50).map((m) => m.text);
}

beforeEach(() => {
  current.id = "be-a";
  vi.clearAllMocks();
});

describe("backend switches keep history", () => {
  it("shared /model <backend> and /model backend default (WhatsApp, Teams, …)", async () => {
    const id = seededChat();
    setSessionId(id, "sess-old");
    const deps = { config, gateway: { backend: null } } as never;

    const out = await switchChatBackend(id, { id: "be-b", label: "B" }, deps);
    expect(out.ok).toBe(true);
    expect(texts(id)).toEqual(["weeks of history"]);
    expect(getChatHistoryState(id)).toBeUndefined();
    // The session was reset, and its id archived rather than lost.
    expect(getArchivedSessions(id).map((e) => [e.sessionId, e.reason])).toEqual(
      [["sess-old", "backend-switch"]],
    );

    await resetChatBackend(id, deps);
    expect(texts(id)).toEqual(["weeks of history"]);
    expect(getChatHistoryState(id)).toBeUndefined();
  });

  it("Discord backend select", async () => {
    const id = seededChat("discord");
    const interaction = {
      values: ["be-b"],
      reply: vi.fn(async () => {}),
      deferUpdate: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    };
    await handleBackendSelect(interaction as never, {
      config,
      gateway: { backend: null } as never,
      chatId: id,
      numericChatId: 1,
    });
    expect(current.id).toBe("be-b");
    expect(outgoing.sessions.resetChat).toHaveBeenCalledWith(id);
    expect(texts(id)).toEqual(["weeks of history"]);
    expect(getChatHistoryState(id)).toBeUndefined();
  });

  it("native backend hand-off", () => {
    const { runtime } = makeNativeHarness();
    const entry = runtime.chats.create();
    pushMessage(entry.id, {
      msgId: 1,
      senderId: 1,
      senderName: "Ada",
      text: "native history",
      timestamp: Date.now(),
    });
    handOffChatBackend(runtime, entry.id);
    expect(texts(entry.id)).toEqual(["native history"]);
    expect(getChatHistoryState(entry.id)).toBeUndefined();
  });
});

describe("resets are soft: context starts fresh, rows stay searchable", () => {
  function expectSoftReset(id: string): void {
    expect(texts(id)).not.toContain("weeks of history");
    expect(getHistoryStats(id).totalMessages).toBeGreaterThanOrEqual(1);
    expect(searchHistory(id, "weeks")).toMatch(
      /^\[before context reset\] .*weeks of history/,
    );
  }

  it("/reset and /new (performSessionReset — Telegram, Discord, WhatsApp, Teams, Telegram /admin kill)", async () => {
    const id = seededChat();
    await performSessionReset(id, outgoing as never);
    expect(outgoing.sessions.resetChat).toHaveBeenCalledWith(id);
    expectSoftReset(id);
  });

  it("Discord /admin kill", async () => {
    const id = seededChat("discord-kill");
    const sent: string[] = [];
    await handleAdminSubcommand(
      "kill",
      id,
      config,
      { backend: null } as never,
      async (text: string) => {
        sent.push(text);
      },
    );
    expect(sent).toEqual([`Session ${id} reset.`]);
    expectSoftReset(id);
  });

  it("native chat reset", () => {
    const { runtime } = makeNativeHarness();
    const entry = runtime.chats.create();
    pushMessage(entry.id, {
      msgId: 1,
      senderId: 1,
      senderName: "Ada",
      text: "weeks of history",
      timestamp: Date.now() - 1_000,
    });
    expect(resetChat(runtime, entry.id)).toBe(true);
    expectSoftReset(entry.id);
  });
});
