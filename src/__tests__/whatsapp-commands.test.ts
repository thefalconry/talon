/**
 * WhatsApp slash commands — the text-only counterparts of Telegram's
 * /model, /effort, /settings, /reset and /status.
 *
 * The backend controller and the socket are stubbed; chat-settings and
 * history run against the per-worker SQLite file, so the assertions are
 * on what the commands persist, not on what they log.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({
  recordMessageProcessed: vi.fn(),
  recordMessageReceived: vi.fn(),
}));
vi.mock("../core/background/pulse/pulse.js", () => ({
  isPulseEnabled: vi.fn(() => false),
  resetPulseCheckpoint: vi.fn(),
}));

const pool = { backendId: "claude" };
const rebindChat = vi.fn(async (_chat: string, id: string) => {
  pool.backendId = id;
  return { ok: true as const };
});
const releaseChat = vi.fn(async (_chat: string) => {
  pool.backendId = "claude";
});
vi.mock("../core/engine/backend-controller/index.js", () => ({
  hasBackendPool: () => true,
  getBackendIdForChat: () => pool.backendId,
  hasChatBackendOverride: () => pool.backendId !== "claude",
  listAvailableBackends: () => [
    { id: "claude", label: "Claude" },
    { id: "codex", label: "Codex" },
  ],
  resolveChatBackend: () => fakeBackend,
  rebindChat: (...args: [string, string]) => rebindChat(...args),
  releaseChat: (...args: [string]) => releaseChat(...args),
  getPooledBackend: () => null,
}));

import {
  canChangeSettings,
  executeWhatsAppCommand,
  handleWhatsAppCommand,
  parseWhatsAppCommand,
} from "../frontend/whatsapp/commands.js";
import {
  getChatModelForBackend,
  getChatSettings,
} from "../storage/chat-settings.js";
import { getRecentHistory, pushMessage } from "../storage/history.js";
import { resetMessageStore } from "../frontend/whatsapp/messages/message-store.js";

const CATALOG = [
  { id: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
  { id: "claude-opus-4", displayName: "Claude Opus 4" },
].map((m) => ({
  ...m,
  provider: "anthropic",
  providerName: "Anthropic",
  selectable: true,
  supportedReasoningLevels: ["low", "medium", "high"],
}));

const fakeBackend = {
  label: "Claude",
  models: {
    listModels: vi.fn(async () => ({ models: CATALOG, total: CATALOG.length })),
    resolveModelInfo: vi.fn(async (query: string) => {
      const model = CATALOG.find((m) => m.id === query);
      return model
        ? { kind: "exact" as const, model, storedValue: model.id }
        : { kind: "missing" as const };
    }),
    getDefaultModelId: () => "claude-sonnet-4",
    getRawModelInfo: async (id: string) => CATALOG.find((m) => m.id === id),
  },
  sessions: { resetChat: vi.fn(), warmSession: vi.fn(async () => {}) },
};

let counter = 0;
function makeRuntime(sent: string[]) {
  const sock = {
    sendMessage: vi.fn(async (_jid: string, content: { text?: string }) => {
      sent.push(content.text ?? "");
      return { key: { id: `S${++counter}`, remoteJid: "x", fromMe: true } };
    }),
  };
  return {
    config: {
      backend: "claude",
      model: "claude-sonnet-4",
      workspace: mkdtempSync(join(tmpdir(), "talon-wa-cmd-")),
      botDisplayName: "Talon",
    },
    gateway: { backend: fakeBackend, incrementMessages: vi.fn() },
    allowedDms: new Set(["100"]),
    allowedGroups: new Set<string>(),
    sock,
  } as never;
}

function inboundFor(
  text: string,
  opts: { isGroup?: boolean; senderId?: string } = {},
) {
  const chatId = `wa_test_${++counter}`;
  return {
    chat: {
      chatId,
      numericChatId: counter,
      jid: opts.isGroup ? "g@g.us" : "100@s.whatsapp.net",
      isGroup: opts.isGroup === true,
    },
    text,
    senderName: "Ada",
    identity: { ids: [opts.senderId ?? "100"], phone: opts.senderId ?? "100" },
    isGroup: opts.isGroup === true,
  };
}

async function run(
  text: string,
  opts?: { isGroup?: boolean; senderId?: string },
) {
  const sent: string[] = [];
  const runtime = makeRuntime(sent);
  const inbound = inboundFor(text, opts);
  const handled = await handleWhatsAppCommand(runtime, inbound);
  return { handled, reply: sent.join("\n"), chatId: inbound.chat.chatId };
}

beforeEach(() => {
  pool.backendId = "claude";
  rebindChat.mockClear();
  releaseChat.mockClear();
  resetMessageStore();
});

describe("parseWhatsAppCommand", () => {
  it("recognises the supported commands and their argument", () => {
    expect(parseWhatsAppCommand("/model")).toEqual({ name: "model", arg: "" });
    expect(parseWhatsAppCommand("/model   3")).toEqual({
      name: "model",
      arg: "3",
    });
    expect(parseWhatsAppCommand("/EFFORT high")).toEqual({
      name: "effort",
      arg: "high",
    });
    expect(parseWhatsAppCommand("/status")).toEqual({
      name: "status",
      arg: "",
    });
  });

  it("skips a leading @mention (group mention mode) and a @bot suffix", () => {
    expect(parseWhatsAppCommand("@353871234567 /settings")).toEqual({
      name: "settings",
      arg: "",
    });
    expect(parseWhatsAppCommand("/model@talon codex")).toEqual({
      name: "model",
      arg: "codex",
    });
  });

  it("ignores unknown commands and slashes that are not commands", () => {
    expect(parseWhatsAppCommand("/pulse on")).toBeNull();
    expect(parseWhatsAppCommand("see /tmp/notes.txt")).toBeNull();
    expect(parseWhatsAppCommand("/tmp/notes.txt")).toBeNull();
    expect(parseWhatsAppCommand("1/2 done")).toBeNull();
    expect(parseWhatsAppCommand("please /reset")).toBeNull();
  });
});

describe("/model", () => {
  it("lists backends and a numbered catalog with the active model marked", async () => {
    const { handled, reply } = await run("/model");
    expect(handled).toBe(true);
    expect(reply).toContain("claude-sonnet-4");
    expect(reply).toContain("Backends:");
    expect(reply).toMatch(/1\. Claude Sonnet 4 — `claude-sonnet-4`.*✓/);
    expect(reply).toContain("2. Claude Opus 4 — `claude-opus-4`");
  });

  it("picks a model by its list number", async () => {
    const { reply, chatId } = await run("/model 2");
    expect(reply).toContain("Model set to claude-opus-4");
    expect(getChatModelForBackend(chatId, "claude")).toBe("claude-opus-4");
    expect(getChatSettings(chatId).backend).toBe("claude");
  });

  it("picks a model by id and rejects an unknown one", async () => {
    const ok = await run("/model claude-opus-4");
    expect(getChatModelForBackend(ok.chatId, "claude")).toBe("claude-opus-4");
    const bad = await run("/model gpt-9");
    expect(bad.reply).toMatch(/No model matched "gpt-9"/);
    expect(getChatModelForBackend(bad.chatId, "claude")).toBeUndefined();
    const range = await run("/model 7");
    expect(range.reply).toMatch(/No model #7/);
  });

  it("clears the pick with /model default", async () => {
    const sent: string[] = [];
    const runtime = makeRuntime(sent);
    const inbound = inboundFor("/model 2");
    await handleWhatsAppCommand(runtime, inbound);
    await handleWhatsAppCommand(runtime, {
      ...inbound,
      text: "/model default",
    });
    expect(sent[1]).toContain("Model reset to default: claude-sonnet-4");
    expect(
      getChatModelForBackend(inbound.chat.chatId, "claude"),
    ).toBeUndefined();
  });

  it("switches backend by name, keeping the local chat log", async () => {
    const sent: string[] = [];
    const runtime = makeRuntime(sent);
    const inbound = inboundFor("/model codex");
    pushMessage(inbound.chat.chatId, {
      msgId: 1,
      senderId: 1,
      senderName: "Ada",
      text: "before the switch",
      timestamp: Date.now(),
    });
    await handleWhatsAppCommand(runtime, inbound);
    expect(rebindChat).toHaveBeenCalledWith(
      inbound.chat.chatId,
      "codex",
      expect.anything(),
    );
    expect(sent[0]).toMatch(/^Backend: Codex/);
    expect(getChatSettings(inbound.chat.chatId).backend).toBe("codex");
    expect(fakeBackend.sessions.resetChat).toHaveBeenCalledWith(
      inbound.chat.chatId,
    );
    // The pre-switch row survives (the bot's own reply is recorded after it).
    expect(getRecentHistory(inbound.chat.chatId, 5)[0].text).toBe(
      "before the switch",
    );

    await handleWhatsAppCommand(runtime, {
      ...inbound,
      text: "/model backend default",
    });
    expect(releaseChat).toHaveBeenCalledWith(inbound.chat.chatId);
    expect(sent[1]).toMatch(/^Backend reset to default \(claude/);
    expect(getChatSettings(inbound.chat.chatId).backend).toBeUndefined();
  });
});

describe("/effort", () => {
  it("shows the active model's levels, sets a valid one, rejects a bad one", async () => {
    const sent: string[] = [];
    const runtime = makeRuntime(sent);
    const inbound = inboundFor("/effort");
    await handleWhatsAppCommand(runtime, inbound);
    // Replies are Markdown; sendText renders WhatsApp's dialect (*bold*).
    expect(sent[0]).toContain("*Effort:* adaptive");
    expect(sent[0]).toContain("low, medium, high");

    await handleWhatsAppCommand(runtime, { ...inbound, text: "/effort high" });
    expect(sent[1]).toBe("Effort set to high.");
    expect(getChatSettings(inbound.chat.chatId).effort).toBe("high");

    await handleWhatsAppCommand(runtime, { ...inbound, text: "/effort turbo" });
    expect(sent[2]).toMatch(/Unknown level/);
    expect(getChatSettings(inbound.chat.chatId).effort).toBe("high");

    await handleWhatsAppCommand(runtime, {
      ...inbound,
      text: "/effort adaptive",
    });
    expect(getChatSettings(inbound.chat.chatId).effort).toBeUndefined();
  });
});

describe("/settings, /status, /reset, /help", () => {
  it("/settings shows model, backend, effort and pulse", async () => {
    const sent: string[] = [];
    const runtime = makeRuntime(sent);
    const inbound = inboundFor("/effort medium");
    await handleWhatsAppCommand(runtime, inbound);
    await handleWhatsAppCommand(runtime, { ...inbound, text: "/settings" });
    expect(sent[1]).toContain("*Settings*");
    expect(sent[1]).toContain("Model: `claude-sonnet-4`");
    expect(sent[1]).toContain("Backend: Claude (`claude`)");
    expect(sent[1]).toContain("Effort: medium");
    expect(sent[1]).toContain("Pulse: off");
  });

  it("/status renders the shared session status", async () => {
    const { reply } = await run("/status");
    expect(reply).toContain("*Talon*");
    expect(reply).toContain("*Context*");
    expect(reply).toContain("*Session*");
    expect(reply).toContain("effort: adaptive");
  });

  it("/reset soft-resets: the chat log is kept, the context starts fresh", async () => {
    const sent: string[] = [];
    const runtime = makeRuntime(sent);
    const inbound = inboundFor("/reset");
    pushMessage(inbound.chat.chatId, {
      msgId: 1,
      senderId: 1,
      senderName: "Ada",
      text: "kept",
      timestamp: Date.now(),
    });
    await handleWhatsAppCommand(runtime, inbound);
    expect(sent[0]).toBe("Session cleared.");
    expect(
      getRecentHistory(inbound.chat.chatId, 5, { includeCleared: true })[0]
        .text,
    ).toBe("kept");
    // The context view starts after the reset (only the bot's own reply).
    expect(
      getRecentHistory(inbound.chat.chatId, 5).map((m) => m.text),
    ).not.toContain("kept");
  });

  it("/help lists every command", async () => {
    const { reply } = await run("/help");
    for (const name of [
      "/model",
      "/effort",
      "/settings",
      "/status",
      "/reset",
    ]) {
      expect(reply).toContain(name);
    }
  });

  it("leaves ordinary messages to the agent turn", async () => {
    const { handled, reply } = await run("what's the plan for today?");
    expect(handled).toBe(false);
    expect(reply).toBe("");
  });
});

describe("group authorisation", () => {
  it("lets only allowlisted senders change settings in a group", async () => {
    const runtime = makeRuntime([]);
    expect(
      canChangeSettings(runtime, {
        isGroup: false,
        identity: { ids: ["999"] },
      }),
    ).toBe(true);
    expect(
      canChangeSettings(runtime, { isGroup: true, identity: { ids: ["999"] } }),
    ).toBe(false);
    expect(
      canChangeSettings(runtime, { isGroup: true, identity: { ids: ["100"] } }),
    ).toBe(true);

    const stranger = inboundFor("/effort low", {
      isGroup: true,
      senderId: "999",
    });
    const refused = await executeWhatsAppCommand(
      runtime,
      { name: "effort", arg: "low" },
      stranger,
    );
    expect(refused).toMatch(/Only allowlisted users/);
    expect(getChatSettings(stranger.chat.chatId).effort).toBeUndefined();

    // Reading settings is open to anyone the group admits.
    const shown = await executeWhatsAppCommand(
      runtime,
      { name: "settings", arg: "" },
      stranger,
    );
    expect(shown).toContain("**Settings**");

    const admin = inboundFor("/effort low", { isGroup: true, senderId: "100" });
    await executeWhatsAppCommand(
      runtime,
      { name: "effort", arg: "low" },
      admin,
    );
    expect(getChatSettings(admin.chat.chatId).effort).toBe("low");
  });

  it("lets nobody in a group change settings when no allowlist is configured", () => {
    // An empty allowlist never means "everyone".
    const runtime = makeRuntime([]) as { allowedDms: Set<string> };
    runtime.allowedDms = new Set();
    expect(
      canChangeSettings(runtime as never, {
        isGroup: true,
        identity: { ids: ["999"] },
      }),
    ).toBe(false);
  });
});
