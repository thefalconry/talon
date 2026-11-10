/**
 * WhatsApp slash commands in the reconnect backlog.
 *
 * Baileys delivers messages queued while the daemon was down as
 * `append` upserts, which handleInbound processes as catch-up. A command
 * in that backlog was issued against an earlier state of the chat, so it
 * must be recorded but not executed — a `/reset` or `/model x` replayed
 * after a restart would silently undo whatever happened since.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));
const execute = vi.fn(async () => {});
vi.mock("../core/engine/dispatcher.js", () => ({
  execute: (...args: unknown[]) => execute(...(args as [])),
}));
vi.mock("../frontend/whatsapp/messages/media-store.js", () => ({
  saveInboundMedia: vi.fn(async () => undefined),
}));
// Stands in for the real handler: claims exactly what the real one would
// (a parseable command), without running it.
const handleWhatsAppCommand = vi.fn(
  async (_runtime: unknown, inbound: { text: string }) =>
    parseWhatsAppCommand(inbound.text) !== null,
);
vi.mock("../frontend/whatsapp/commands.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../frontend/whatsapp/commands.js")
  >()),
  handleWhatsAppCommand: (...args: unknown[]) =>
    handleWhatsAppCommand(...(args as [unknown, { text: string }])),
}));

import { parseWhatsAppCommand } from "../frontend/whatsapp/commands.js";
import { handleInbound } from "../frontend/whatsapp/messages/inbound.js";
import { resetMessageStore } from "../frontend/whatsapp/messages/message-store.js";
import { resetWhatsAppRegistry } from "../frontend/whatsapp/registry.js";
import { getRecentHistory } from "../storage/history.js";
import { purgeChat as deleteChat } from "../storage/repositories/history-repo.js";

const CHAT = "wa_dm_100";

function runtime() {
  return {
    config: { botDisplayName: "Talon" },
    gateway: { backend: null, incrementMessages: vi.fn() },
    settings: {
      respondMode: "mention",
      groupPolicy: "listed",
      sendReadReceipts: false,
    },
    allowedDms: new Set(["100"]),
    allowedGroups: new Set<string>(),
    groupAllowCache: new Map(),
    selfIds: ["999"],
    sock: {
      sendMessage: vi.fn(async () => ({ key: { id: "S", remoteJid: "x" } })),
    },
    stopping: false,
    reconnectDelay: 0,
    unpairedNotified: false,
  };
}

let seq = 0;
function dm(text: string, sentAtMs: number) {
  seq += 1;
  return {
    key: {
      remoteJid: "100@s.whatsapp.net",
      id: `CATCHUP${seq}`,
      fromMe: false,
    },
    message: { conversation: text },
    messageTimestamp: Math.floor(sentAtMs / 1000),
    pushName: "Alice",
  } as never;
}

function sentTexts(rt: ReturnType<typeof runtime>): string[] {
  return rt.sock.sendMessage.mock.calls.map(
    (call) => (call as unknown as [string, { text?: string }])[1]?.text ?? "",
  );
}

beforeEach(() => {
  resetMessageStore();
  resetWhatsAppRegistry();
  deleteChat(CHAT);
  execute.mockClear();
  handleWhatsAppCommand.mockClear();
});

describe("WhatsApp commands in the catch-up backlog", () => {
  it("runs a live command", async () => {
    const rt = runtime();
    await handleInbound(rt as never, dm("/reset", Date.now()));
    expect(handleWhatsAppCommand).toHaveBeenCalledTimes(1);
  });

  it("does not run a command delivered as catch-up", async () => {
    const rt = runtime();
    await handleInbound(rt as never, dm("/reset", Date.now() - 30_000), {
      catchUp: true,
    });
    expect(handleWhatsAppCommand).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    // Still recorded, like any other catch-up message.
    expect(getRecentHistory(CHAT, 5).map((r) => r.text)).toContain("/reset");
  });

  it("tells the sender a fresh skipped command was not run", async () => {
    const rt = runtime();
    await handleInbound(rt as never, dm("/model opus", Date.now() - 30_000), {
      catchUp: true,
    });
    const texts = sentTexts(rt);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("/model");
    expect(texts[0]).toContain("Send it again");
  });

  it("stays silent about a stale skipped command", async () => {
    const rt = runtime();
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await handleInbound(rt as never, dm("/reset", twoDaysAgo), {
      catchUp: true,
    });
    expect(handleWhatsAppCommand).not.toHaveBeenCalled();
    expect(sentTexts(rt)).toEqual([]);
  });

  it("still treats plain catch-up text as a message, not a command", async () => {
    const rt = runtime();
    await handleInbound(rt as never, dm("hello", Date.now() - 30_000), {
      catchUp: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
