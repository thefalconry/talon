/**
 * The bridge handler seam — the table `server.ts`'s routes call, plus the
 * daemon status behind it.
 *
 * Everything here goes through `buildBridgeHandlers(runtime)` rather than
 * the module functions directly, because the seam is what the transport
 * sees: each entry has to answer with the shape `protocol.ts` declares and
 * must never throw across the wire. The dispatcher and the backend
 * controller are stubbed; the stores are the real per-worker throwaway
 * ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../core/engine/dispatcher.js";
import { buildBridgeHandlers } from "../frontend/native/surface/handlers.js";
import { BRIDGE_PROTOCOL_VERSION } from "../frontend/native/protocol.js";
import { registerMedia } from "../frontend/native/media/media.js";
import type { BridgeServerHandlers } from "../frontend/native/bridge/server.js";
import {
  getChatModelForBackend,
  getChatSettings,
} from "../storage/chat-settings.js";
import { files } from "../util/paths.js";
import { logWarn } from "../util/log.js";
import { makeNativeHarness, settle } from "./helpers/native-bridge.js";

let harness: ReturnType<typeof makeNativeHarness>;
let handlers: BridgeServerHandlers;

beforeEach(() => {
  vi.clearAllMocks();
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

describe("bridge status", () => {
  it("reports the daemon identity the protocol declares", () => {
    expect(handlers.status()).toMatchObject({
      app: "talon-bridge",
      protocol: BRIDGE_PROTOCOL_VERSION,
      botName: "Talon",
      backend: "claude",
      model: "test-model",
      activeChats: 0,
    });
  });

  it("advertises the capabilities clients feature-detect on", () => {
    expect(handlers.status().capabilities).toEqual([
      "mesh",
      "mesh-commands",
      "plugins-skills",
      "attachments",
    ]);
  });

  it("counts the live chats", () => {
    harness.runtime.chats.create();
    harness.runtime.chats.create();
    expect(handlers.status().activeChats).toBe(2);
  });
});

describe("bridge chat handlers", () => {
  it("mints a chat that the listing then reports", () => {
    const chat = handlers.createChat("Notes");
    expect(handlers.listChats()).toMatchObject([
      { id: chat.id, title: "Notes" },
    ]);
  });

  it("answers a rename with the updated chat", () => {
    const chat = handlers.createChat();
    expect(handlers.renameChat(chat.id, "Renamed")).toMatchObject({
      id: chat.id,
      title: "Renamed",
    });
  });

  it("drops a deleted chat from the listing", () => {
    const chat = handlers.createChat();
    expect(handlers.deleteChat(chat.id)).toBe(true);
    expect(handlers.listChats()).toHaveLength(0);
  });

  it("serves a chat's transcript and finds it again by search", async () => {
    const chat = handlers.createChat();
    handlers.send(chat.id, "ptarmigan sighting", undefined);
    await settle();

    expect(handlers.history(chat.id, {})).toMatchObject([
      { role: "user", text: "ptarmigan sighting" },
    ]);
    expect(handlers.search("ptarmigan", chat.id)).toMatchObject([
      { chatId: chat.id, message: { text: "ptarmigan sighting" } },
    ]);
  });

  it("reads memory through the store's own reader", () => {
    expect(handlers.listMemory({})).toMatchObject({ ok: true });
    expect(handlers.memoryWhy(987654321)).toBeNull();
  });

  it("resets a chat it knows and refuses one it does not", () => {
    const chat = handlers.createChat();
    expect(handlers.resetChat(chat.id)).toBe(true);
    expect(handlers.resetChat("d_missing")).toBe(false);
  });

  it("syncs a pulse toggle to clients and persists it", () => {
    const chat = handlers.createChat();
    handlers.setPulse(chat.id, true);
    expect(getChatSettings(chat.id).pulse).toBe(true);
    expect(harness.eventsOf("chat_updated")).toMatchObject([
      { chat: { id: chat.id, pulse: true } },
    ]);
  });

  it("ignores a pulse toggle for a chat it does not know", () => {
    handlers.setPulse("d_missing", true);
    expect(harness.eventsOf("chat_updated")).toHaveLength(0);
  });

  it("reports no interrupt when nothing is running", async () => {
    const chat = handlers.createChat();
    await expect(handlers.interruptTurn(chat.id)).resolves.toBe(false);
  });

  it("replays nothing when no turn is in flight", () => {
    expect(handlers.liveTurnEvents()).toEqual([]);
  });
});

describe("bridge send", () => {
  it("runs a turn for the addressed chat", async () => {
    const chat = handlers.createChat();
    handlers.send(chat.id, "hello", undefined);
    await settle();

    expect(vi.mocked(execute).mock.calls[0]![0]).toMatchObject({
      chatId: chat.id,
      prompt: "hello",
    });
  });

  it("adopts a chat id the client supplied but the registry never saw", async () => {
    handlers.send("d_deeplink", "hi", undefined);
    await settle();
    expect(harness.runtime.chats.get("d_deeplink")).toBeDefined();
  });

  it("queues a second message instead of running a concurrent turn", async () => {
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
    handlers.send(chat.id, "first", undefined);
    handlers.send(chat.id, "second", undefined);

    expect(harness.runtime.queuedByChat.get(chat.id)).toMatchObject({
      text: "second",
    });
    expect(vi.mocked(execute)).toHaveBeenCalledOnce();
    release();
    await settle(4);
  });

  it("combines follow-ups sent while busy instead of replacing the queue", async () => {
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
    handlers.send(chat.id, "first", undefined);
    handlers.send(chat.id, "second", undefined);
    handlers.send(chat.id, "  third  ", undefined);

    expect(harness.runtime.queuedByChat.get(chat.id)).toMatchObject({
      text: "second\n\nthird",
    });
    expect(vi.mocked(execute)).toHaveBeenCalledOnce();
    release();
    await settle(4);
  });

  it("runs a queued follow-up before a message sent as the turn settles", async () => {
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
    handlers.send(chat.id, "first", undefined);
    handlers.send(chat.id, "second", undefined);
    release();
    // The first turn settles on microtasks alone; a /send can land before
    // any immediate or timer runs.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    handlers.send(chat.id, "third", undefined);
    await settle(6);

    expect(vi.mocked(execute).mock.calls.map((c) => c[0]!.prompt)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("drops an attachment reference this daemon run never minted", async () => {
    const chat = handlers.createChat();
    handlers.send(chat.id, "look", {
      attachments: [{ url: "/media?id=from-a-previous-run" }],
    });
    await settle();

    expect(vi.mocked(execute).mock.calls[0]![0]!.prompt).toBe("look");
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
      "native",
      expect.stringContaining("dropped 1 unknown attachment reference"),
    );
  });

  it("resolves a legacy single-image reference against what it stored", async () => {
    const chat = handlers.createChat();
    harness.runtime.uploads.set("m1", {
      path: "/uploads/shot.png",
      name: "shot.png",
      size: 4,
      mimeType: "image/png",
      url: "/media?id=m1",
      image: true,
    });
    handlers.send(chat.id, "look", { imagePath: "/media?id=m1" });
    await settle();

    expect(vi.mocked(execute).mock.calls[0]![0]!.prompt).toContain(
      "[Attached image: /uploads/shot.png]",
    );
  });

  it("keeps the queued files when the queued text is edited", () => {
    const chat = handlers.createChat();
    const attachment = {
      path: "/uploads/a.zip",
      name: "a.zip",
      size: 4,
      mimeType: "application/zip",
      url: "/media?id=a",
      image: false,
    };
    harness.runtime.queuedByChat.set(chat.id, {
      text: "old",
      attachments: [attachment],
    });
    handlers.queueMessage(chat.id, "new text");

    expect(harness.runtime.queuedByChat.get(chat.id)).toEqual({
      text: "new text",
      attachments: [attachment],
    });
  });

  it("cancels the whole follow-up, files included, on empty text", () => {
    const chat = handlers.createChat();
    harness.runtime.queuedByChat.set(chat.id, {
      text: "old",
      attachments: [
        {
          path: "/uploads/a.zip",
          name: "a.zip",
          size: 4,
          mimeType: "application/zip",
          url: "/media?id=a",
          image: false,
        },
      ],
    });
    handlers.queueMessage(chat.id, "  ");

    expect(harness.runtime.queuedByChat.has(chat.id)).toBe(false);
  });

  it("ignores a queue edit for a chat it does not know", () => {
    handlers.queueMessage("d_missing", "hi");
    expect(harness.runtime.queuedByChat.size).toBe(0);
  });
});

describe("bridge pickers, config and media", () => {
  it("answers the model list even with no backend bound", async () => {
    const chat = handlers.createChat();
    await expect(handlers.listModels(chat.id)).resolves.toEqual({
      active: "test-model",
      models: [],
    });
  });

  it("answers the backend list from config", () => {
    const chat = handlers.createChat();
    expect(handlers.listBackends(chat.id)).toMatchObject({
      active: "claude",
      backends: [{ id: "claude", label: "Claude" }],
    });
  });

  it("reports a bad backend switch as an error rather than throwing", async () => {
    await expect(handlers.setBackend("d_missing", "kilo")).resolves.toEqual({
      ok: false,
      error: "No such chat",
    });
  });

  it("persists an effort pick for the chat", () => {
    const chat = handlers.createChat();
    handlers.setEffort(chat.id, "high");
    expect(getChatSettings(chat.id).effort).toBe("high");
  });

  it("persists a model pick against the config backend when the pool is unbound", () => {
    // The stub throws from `getBackendIdForChat`, as the controller does
    // before the pool binds. The pick has to land somewhere sensible rather
    // than 400ing the route and being dropped.
    const chat = handlers.createChat();
    handlers.setModel(chat.id, "sonnet");
    expect(getChatModelForBackend(chat.id, "claude")).toBe("sonnet");
  });

  it("answers the effort levels even when the backend cannot be asked", async () => {
    const chat = handlers.createChat();
    await expect(handlers.effortLevels(chat.id)).resolves.toEqual({
      active: "adaptive",
      levels: [],
    });
  });

  it("exposes the config snapshot with its editable keys", () => {
    expect(handlers.getConfig().editable.length).toBeGreaterThan(0);
  });

  it("pushes a fresh status after a config update", () => {
    // `backend` is not editable through the bridge — the update is a no-op,
    // but clients are still resynced.
    expect(handlers.setConfig({ backend: "codex" }).backend).toBe("claude");
    expect(harness.eventsOf("status")).toHaveLength(1);
  });

  it("lists the configured plugins", () => {
    expect(Array.isArray(handlers.listPlugins())).toBe(true);
  });

  it("resolves a registered media id to its file, and an unknown one to null", () => {
    const id = registerMedia(harness.runtime, "/tmp/pic.png");
    expect(handlers.mediaPath(id)).toBe("/tmp/pic.png");
    expect(handlers.mediaPath("nope")).toBeNull();
  });

  it("serves log entries from the daemon's log file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-handler-logs-"));
    const path = join(dir, "talon.log");
    await writeFile(
      path,
      `${JSON.stringify({ level: 30, time: Date.now(), component: "native", msg: "ready" })}\n`,
    );
    const original = files.log;
    (files as { log: string }).log = path;
    try {
      expect(handlers.logs({ lines: 10 })).toMatchObject([{ msg: "ready" }]);
    } finally {
      (files as { log: string }).log = original;
    }
  });
});

describe("bridge mesh routes", () => {
  /** Each mesh route is a straight shim over the shared core service. */
  const shims: [string, string, unknown[]][] = [
    ["registerDevice", "register", [{ id: "phone" }]],
    ["storeLocation", "storeLocation", [{ deviceId: "phone" }]],
    ["listDevices", "list", []],
    ["completeCommand", "completeCommand", [{ id: "c1" }]],
    ["acceptFileUpload", "acceptFileUpload", ["tok", {}, "phone"]],
    ["openFileDownload", "openFileDownload", ["tok", "phone"]],
    ["openCompanionPair", "openCompanionPair", ["tok", "png"]],
    ["openNodeInstall", "openNodeInstall", ["tok", "linux", "arm64"]],
    ["openNodeBinary", "openNodeBinary", ["tok"]],
  ];

  type Shimmable = Record<string, (...args: unknown[]) => unknown>;

  it("forwards every mesh route to the shared mesh service", () => {
    // The service is a process-wide singleton, so each method is shadowed
    // with an own property and the shadow removed again afterwards.
    const mesh = harness.runtime.mesh as unknown as Shimmable;
    const table = handlers as unknown as Shimmable;
    const shadowed: string[] = [];
    try {
      for (const [key, method, args] of shims) {
        const spy = vi.fn(() => `answered:${method}`);
        mesh[method] = spy;
        shadowed.push(method);
        expect(table[key]!(...args), `${key} did not delegate`).toBe(
          `answered:${method}`,
        );
        expect(spy).toHaveBeenCalledWith(...args);
      }
    } finally {
      for (const method of shadowed) delete mesh[method];
    }
  });
});
