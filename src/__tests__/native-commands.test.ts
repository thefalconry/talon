/**
 * Slash commands on the native bridge — `/send` text that names one of
 * the daemon's commands is answered by the daemon; anything else, `/foo`
 * included, still runs a model turn.
 *
 * Driven through `buildBridgeHandlers(runtime)`, the seam the `/send`
 * route calls, with the caller's operator scope passed the way the route
 * derives it. The dispatcher, backend controller and respawn are
 * stubbed; the backup store is the real one except for the Talon home,
 * which points at a scratch directory so a staged restore can never land
 * in the real ~/.talon.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/engine/dispatcher.js", () => ({ execute: vi.fn() }));

vi.mock("../core/engine/backend-controller/index.js", () => ({
  getBackendForChat: vi.fn(() => null),
  getBackendIdForChat: vi.fn(() => {
    throw new Error("backend pool not bound");
  }),
  getPooledBackend: vi.fn(() => null),
  acquireBackendInstance: vi.fn(async () => {
    throw new Error("no backend");
  }),
  listAvailableBackends: vi.fn(() => [{ id: "claude", label: "Claude" }]),
  rebindChat: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../core/daemon/respawn.js", () => ({ respawnSelf: vi.fn() }));

const SNAPSHOT_ID = "20260930T120000Z-abc123";
const scratchHome = mkdtempSync(join(tmpdir(), "talon-native-cmd-"));

vi.mock("../core/backup/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../core/backup/index.js")>();
  return {
    ...actual,
    // One snapshot exists on "this machine".
    readManifest: vi.fn(async (id: string) =>
      id === SNAPSHOT_ID
        ? {
            id,
            kind: "checkpoint",
            label: "before the rewrite",
            pinned: true,
            createdAt: Date.parse("2026-09-30T12:00:00Z"),
            host: "test",
            talonVersion: "0.0.0",
            parts: [],
            includes: ["config.json"],
            excludes: [],
            sizeBytes: 1024,
            remote: {},
          }
        : null,
    ),
    // The real writer, into the scratch home rather than ~/.talon.
    writeRestorePending: vi.fn((request: { id: string }) =>
      actual.writeRestorePending(
        request as Parameters<typeof actual.writeRestorePending>[0],
        scratchHome,
      ),
    ),
  };
});

import { execute } from "../core/engine/dispatcher.js";
import { respawnSelf } from "../core/daemon/respawn.js";
import { restorePendingPath } from "../core/backup/restore.js";
import { buildBridgeHandlers } from "../frontend/native/surface/handlers.js";
import { parseNativeCommand } from "../frontend/native/commands/index.js";
import { NATIVE_COMMANDS } from "../frontend/native/commands/definitions.js";
import type { BridgeServerHandlers } from "../frontend/native/bridge/server.js";
import { makeNativeHarness, settle } from "./helpers/native-bridge.js";

let harness: ReturnType<typeof makeNativeHarness>;
let handlers: BridgeServerHandlers;

const OPERATOR = { operator: true };
const CLIENT_ONLY = { operator: false };

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(restorePendingPath(scratchHome), { force: true });
  vi.mocked(execute).mockResolvedValue({
    text: "",
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    bridgeMessageCount: 1,
  });
  harness = makeNativeHarness();
  handlers = buildBridgeHandlers(harness.runtime);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(scratchHome, { recursive: true, force: true });
});

/** Every assistant message text broadcast for a chat, in order. */
function replies(chatId: string): string[] {
  return harness
    .eventsOf("message")
    .filter((e) => e.chatId === chatId && e.message.role === "assistant")
    .map((e) => e.message.text);
}

async function send(
  text: string,
  caller?: { operator: boolean },
): Promise<string> {
  const chat = handlers.createChat();
  handlers.send(chat.id, text, undefined, caller);
  await settle(4);
  return chat.id;
}

describe("parseNativeCommand", () => {
  it("matches registered names, case-insensitively, with their argument", () => {
    expect(parseNativeCommand("/help")).toEqual({ name: "help", arg: "" });
    expect(parseNativeCommand("  /Backup restore X  ")).toEqual({
      name: "backup",
      arg: "restore X",
    });
  });

  it("leaves unknown commands, paths and prose alone", () => {
    expect(parseNativeCommand("/foo bar")).toBeNull();
    expect(parseNativeCommand("/etc/hosts is broken")).toBeNull();
    expect(parseNativeCommand("1/2 cup")).toBeNull();
    expect(parseNativeCommand("please /help me")).toBeNull();
  });
});

describe("native slash commands", () => {
  it("answers /help itself, listing every command, without a model turn", async () => {
    const chatId = await send("/help", OPERATOR);

    expect(execute).not.toHaveBeenCalled();
    const [help] = replies(chatId);
    for (const cmd of NATIVE_COMMANDS) expect(help).toContain(`/${cmd.name}`);
    // The command and its answer stay in the transcript across a reload.
    expect(handlers.history(chatId, {})).toMatchObject([
      { role: "user", text: "/help" },
      { role: "assistant", text: help },
    ]);
  });

  it("does not retitle the chat after a command", async () => {
    const chatId = await send("/help", OPERATOR);
    expect(harness.runtime.chats.get(chatId)?.title).not.toBe("/help");
  });

  it("sends unknown slash text to the model as an ordinary message", async () => {
    const chatId = await send("/foo bar", OPERATOR);

    expect(vi.mocked(execute).mock.calls[0]![0]).toMatchObject({
      chatId,
      prompt: "/foo bar",
    });
  });

  it("gives a command with files attached to the model", async () => {
    const chat = handlers.createChat();
    const attachment = await handlers.upload(
      "notes.txt",
      "text/plain",
      (await import("node:stream")).Readable.from([Buffer.from("hi")]),
    );
    handlers.send(
      chat.id,
      "/help",
      { attachments: [{ url: attachment.url, path: attachment.path }] },
      OPERATOR,
    );
    await settle(4);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("answers while a turn is running instead of queueing behind it", async () => {
    let release!: () => void;
    vi.mocked(execute).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return {
        text: "",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        bridgeMessageCount: 1,
      };
    });
    const chat = handlers.createChat();
    handlers.send(chat.id, "long job", undefined, OPERATOR);
    handlers.send(chat.id, "/ping", undefined, OPERATOR);
    await settle(4);

    expect(harness.runtime.queuedByChat.get(chat.id)).toBeUndefined();
    expect(replies(chat.id).some((t) => t.startsWith("Pong!"))).toBe(true);
    release();
    await settle(4);
  });

  it("serves the command list for client autocomplete", () => {
    const commands = handlers.listCommands();
    expect(commands.map((c) => c.name)).toEqual(
      NATIVE_COMMANDS.map((c) => c.name),
    );
    expect(commands.find((c) => c.name === "backup")).toMatchObject({
      admin: true,
      args: expect.stringContaining("restore <id>"),
    });
    expect(commands.find((c) => c.name === "help")?.admin).toBeUndefined();
    expect(handlers.status().capabilities).toContain("commands");
  });
});

describe("/backup restore", () => {
  it("asks for a typed confirmation before staging anything", async () => {
    const chatId = await send(`/backup restore ${SNAPSHOT_ID}`, OPERATOR);

    expect(replies(chatId).join("\n")).toContain(
      `/backup restore ${SNAPSHOT_ID} confirm`,
    );
    expect(existsSync(restorePendingPath(scratchHome))).toBe(false);
    expect(respawnSelf).not.toHaveBeenCalled();
  });

  it("stages restore-pending.json and restarts for an operator", async () => {
    const chatId = await send(
      `/backup restore ${SNAPSHOT_ID} confirm`,
      OPERATOR,
    );
    // Staging is real file I/O — wait for the hand-off rather than a tick count.
    await vi.waitFor(() => expect(respawnSelf).toHaveBeenCalled());

    const staged = JSON.parse(
      readFileSync(restorePendingPath(scratchHome), "utf8"),
    ) as { id: string; requestedBy: string; frontend: string };
    expect(staged).toMatchObject({
      id: SNAPSHOT_ID,
      requestedBy: chatId,
      frontend: "native",
    });
    expect(respawnSelf).toHaveBeenCalledWith(
      `native /backup restore ${SNAPSHOT_ID}`,
    );
    expect(replies(chatId).join("\n")).toContain("Restoring");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a credential without the operator scope", async () => {
    const chatId = await send(
      `/backup restore ${SNAPSHOT_ID} confirm`,
      CLIENT_ONLY,
    );

    expect(existsSync(restorePendingPath(scratchHome))).toBe(false);
    expect(respawnSelf).not.toHaveBeenCalled();
    expect(replies(chatId)).toEqual([
      expect.stringContaining("Not authorized"),
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats a caller with no stated scope as not an operator", async () => {
    await send(`/backup restore ${SNAPSHOT_ID} confirm`);
    expect(existsSync(restorePendingPath(scratchHome))).toBe(false);
    expect(respawnSelf).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a snapshot", async () => {
    const chatId = await send("/backup restore nope confirm", OPERATOR);
    expect(replies(chatId).join("\n")).toContain("not a snapshot id");
    expect(respawnSelf).not.toHaveBeenCalled();
  });

  it("shows a snapshot's manifest", async () => {
    const chatId = await send(`/backup show ${SNAPSHOT_ID}`, OPERATOR);
    expect(replies(chatId).join("\n")).toContain("before the rewrite");
  });
});
