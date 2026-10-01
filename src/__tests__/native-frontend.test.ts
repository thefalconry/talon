/**
 * Unit tests for the `native` frontend's pure pieces — the bits that don't
 * need a live daemon or DB:
 *   - protocol mappers (previewOf, historyToClientMessage)
 *   - the in-memory chat registry (ensure/get/byNumeric/list ordering)
 *   - the gateway action handler (delivery tools → bridge events)
 *   - the settings snapshot + allowlist enforcement
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previewOf,
  historyToClientMessage,
  BOT_SENDER_ID,
  USER_SENDER_ID,
  type BridgeStatus,
} from "../frontend/native/protocol.js";
import {
  NativeChats,
  DEFAULT_CHAT_TITLE,
} from "../frontend/native/chats/chats.js";
import { MeshRegistry } from "../core/mesh/index.js";
import { TransferStore } from "../core/mesh/transfers/transfers.js";
import { writeFile as fsWriteFile } from "node:fs/promises";
import {
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";
import { extractSessionName } from "../core/weaver/session-name.js";
import { createNativeActionHandler } from "../frontend/native/turn/actions.js";
import {
  configSnapshot,
  applyConfigUpdate,
  EDITABLE,
} from "../frontend/native/surface/settings.js";
import {
  removeBridgeDiscovery,
  writeBridgeDiscovery,
} from "../frontend/native/bridge/discovery.js";
import { summarizeToolResult } from "../frontend/native/index.js";
import { files } from "../util/paths.js";
import { deriveNumericChatId } from "../core/frontend-runtime/chat-id.js";
import type { Gateway } from "../core/engine/gateway.js";
import type { TalonConfig } from "../core/config/index.js";

describe("native protocol mappers", () => {
  it("previewOf collapses whitespace and clips long text", () => {
    expect(previewOf("  hello   world \n there ")).toBe("hello world there");
    const long = "x".repeat(200);
    const out = previewOf(long, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("historyToClientMessage maps sender ids to roles", () => {
    const assistant = historyToClientMessage(
      {
        msgId: 5,
        senderId: BOT_SENDER_ID,
        senderName: "Talon",
        text: "hi",
        timestamp: 10,
      },
      "d_1",
    );
    expect(assistant).toMatchObject({
      id: "5",
      role: "assistant",
      text: "hi",
      ts: 10,
    });

    const user = historyToClientMessage(
      {
        msgId: 6,
        senderId: USER_SENDER_ID,
        senderName: "User",
        text: "yo",
        timestamp: 11,
      },
      "d_1",
    );
    expect(user.role).toBe("user");
  });
});

describe("NativeChats registry", () => {
  it("creates, indexes by string + numeric id, and lists newest-first", () => {
    const chats = new NativeChats();
    const a = chats.create();
    const b = chats.create();
    expect(chats.get(a.id)).toBe(a);
    expect(chats.byNumeric(a.numericId)).toBe(a);
    expect(chats.count()).toBe(2);

    // Touch `a` so it becomes most-recent; list() is newest-first.
    chats.touch(a.id, "latest message");
    const list = chats.list();
    expect(list[0].id).toBe(a.id);
    expect(list[0].preview).toBe("latest message");
    expect(list).toContain(b);
  });

  it("ensure() adopts a client-supplied id without duplicating", () => {
    const chats = new NativeChats();
    const first = chats.ensure("d_supplied");
    const again = chats.ensure("d_supplied");
    expect(first).toBe(again);
    expect(chats.count()).toBe(1);
  });

  it("auto-titles a placeholder chat from the first message, but never a renamed one", () => {
    // Mirrors maybeAutoTitle(): only rename while the chat still carries the
    // placeholder, and derive the title for free from the first message.
    const chats = new NativeChats();
    const fresh = chats.create();
    expect(fresh.title).toBe(DEFAULT_CHAT_TITLE);

    const autoTitle = (id: string, text: string) => {
      const entry = chats.get(id);
      if (!entry || (entry.title && entry.title !== DEFAULT_CHAT_TITLE)) return;
      const t = extractSessionName(text);
      if (t) chats.rename(id, t);
    };

    autoTitle(fresh.id, "[User] Improve the companion app UI [msg_id:42]");
    expect(chats.get(fresh.id)!.title).toBe("Improve the companion app UI");

    // A second message must not overwrite the now-named chat.
    autoTitle(fresh.id, "and also fix the padding");
    expect(chats.get(fresh.id)!.title).toBe("Improve the companion app UI");
  });

  it("leaves the placeholder when the first message has no usable text", () => {
    const chats = new NativeChats();
    const fresh = chats.create();
    const derived = extractSessionName("[User] [msg_id:7]");
    expect(derived).toBeUndefined();
    expect(fresh.title).toBe(DEFAULT_CHAT_TITLE);
  });

  // "New chat" creates a real chat the moment it's tapped, so an abandoned one
  // used to sit in every client's list forever. unused() is what the daemon's
  // periodic sweep reaps.
  it("reports chats that were created but never used, oldest first", () => {
    const chats = new NativeChats();
    const now = Date.now();
    const abandoned = chats.create();
    const alsoAbandoned = chats.create();
    const talked = chats.create();
    abandoned.createdAt = now - 3 * 60 * 60_000;
    alsoAbandoned.createdAt = now - 2 * 60 * 60_000;
    talked.createdAt = now - 4 * 60 * 60_000;
    chats.touch(talked.id, "a real message");

    const stale = chats.unused(60 * 60_000, now);
    expect(stale.map((c) => c.id)).toEqual([abandoned.id, alsoAbandoned.id]);

    // A fresh one is protected by the grace period — someone may be typing
    // into it right now.
    const justMade = chats.create();
    expect(chats.unused(60 * 60_000, now).map((c) => c.id)).not.toContain(
      justMade.id,
    );
  });

  it("keeps a used chat sweepable-proof even after its history is cleared", () => {
    // A reset chat has no history either; only `used` tells the two apart,
    // and a deliberate reset must never look like an abandoned "New chat".
    const chats = new NativeChats();
    const entry = chats.create();
    entry.createdAt = Date.now() - 24 * 60 * 60_000;
    chats.touch(entry.id, "hello");
    entry.preview = "";
    expect(chats.unused(60 * 60_000)).toHaveLength(0);
  });
});

describe("native bridge discovery", () => {
  it("writes and removes the loopback discovery file", async () => {
    const original = files.nativeBridge;
    const dir = await mkdtemp(join(tmpdir(), "talon-native-discovery-"));
    const path = join(dir, "native-bridge.json");
    (files as { nativeBridge: string }).nativeBridge = path;
    try {
      await writeBridgeDiscovery({
        port: 19999,
        token: "secret",
        scheme: "http",
        startedAt: 123,
      });

      const raw = await readFile(path, "utf8");
      const json = JSON.parse(raw) as Record<string, unknown>;
      expect(json).toMatchObject({
        host: "127.0.0.1",
        port: 19999,
        token: "secret",
        scheme: "http",
        pid: process.pid,
        protocol: 1,
        startedAt: 123,
      });
      expect(typeof json.updatedAt).toBe("number");
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }

      await removeBridgeDiscovery();
      await expect(readFile(path, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      (files as { nativeBridge: string }).nativeBridge = original;
    }
  });
});

describe("native action handler", () => {
  function setup() {
    const chats = new NativeChats();
    const entry = chats.ensure("d_action");
    const incrementMessages = vi.fn();
    const gateway = { incrementMessages } as unknown as Gateway;
    const emitAssistant = vi.fn().mockReturnValue(4242);
    const emitPhoto = vi.fn().mockReturnValue(4343);
    const broadcast = vi.fn();
    const handler = createNativeActionHandler({
      chats,
      gateway,
      emitAssistant,
      emitPhoto,
      broadcast,
    });
    return {
      chats,
      entry,
      handler,
      incrementMessages,
      emitAssistant,
      emitPhoto,
      broadcast,
    };
  }

  it("delivers send_message as an assistant message and counts it", async () => {
    const { entry, handler, incrementMessages, emitAssistant } = setup();
    const res = await handler(
      { action: "send_message", text: "hello" },
      entry.numericId,
    );
    expect(emitAssistant).toHaveBeenCalledWith(entry, "hello");
    expect(incrementMessages).toHaveBeenCalledWith(entry.numericId);
    expect(res).toMatchObject({ ok: true, message_id: 4242 });
  });

  it("maps button rows on send_message_with_buttons", async () => {
    const { entry, handler, emitAssistant } = setup();
    await handler(
      {
        action: "send_message_with_buttons",
        text: "pick",
        rows: [[{ text: "Docs", url: "https://x" }]],
      },
      entry.numericId,
    );
    expect(emitAssistant).toHaveBeenCalledWith(entry, "pick", [
      [{ text: "Docs", url: "https://x", data: undefined }],
    ]);
  });

  it("delivers send_photo as a photo message with caption", async () => {
    const { entry, handler, incrementMessages, emitPhoto } = setup();
    const res = await handler(
      { action: "send_photo", file_path: "/tmp/x.png", caption: "look" },
      entry.numericId,
    );
    expect(emitPhoto).toHaveBeenCalledWith(entry, "/tmp/x.png", "look");
    expect(incrementMessages).toHaveBeenCalledWith(entry.numericId);
    expect(res).toMatchObject({ ok: true, message_id: 4343 });
  });

  it("rejects send_photo without a file_path", async () => {
    const { entry, handler, emitPhoto } = setup();
    const res = await handler({ action: "send_photo" }, entry.numericId);
    expect(emitPhoto).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false });
  });

  it("broadcasts a reaction event", async () => {
    const { entry, handler, broadcast } = setup();
    const res = await handler(
      { action: "react", message_id: 7, emoji: "🔥" },
      entry.numericId,
    );
    expect(res).toMatchObject({ ok: true });
    expect(broadcast).toHaveBeenCalledWith({
      kind: "reaction",
      chatId: entry.id,
      messageId: "7",
      emoji: "🔥",
    });
  });

  it("answers get_chat_info and returns null for unknown actions", async () => {
    const { entry, handler } = setup();
    const info = await handler({ action: "get_chat_info" }, entry.numericId);
    expect(info).toMatchObject({
      ok: true,
      id: entry.numericId,
      type: "private",
    });

    const unknown = await handler(
      { action: "totally_made_up" },
      entry.numericId,
    );
    expect(unknown).toBeNull();
  });

  it("rejects actions for an unknown chat", async () => {
    const { handler } = setup();
    const res = await handler({ action: "send_message", text: "x" }, 999999);
    expect(res).toMatchObject({ ok: false });
  });

  it("adopts an unlisted chat a send_message names by key", async () => {
    const { chats, handler, emitAssistant } = setup();
    const key = "d_1700000000000_restor";
    expect(chats.get(key)).toBeUndefined();
    const res = await handler(
      { action: "send_message", text: "♻️ Restored", target: key },
      deriveNumericChatId(key),
    );
    expect(res).toMatchObject({ ok: true });
    const adopted = chats.get(key);
    expect(adopted).toBeDefined();
    expect(emitAssistant).toHaveBeenCalledWith(adopted, "♻️ Restored");
  });

  it("adopts nothing when the key doesn't match the id, or isn't a send", async () => {
    const { chats, handler } = setup();
    const key = "d_1700000000000_other";
    // The key names a different chat than the numeric id.
    expect(
      await handler({ action: "send_message", text: "x", target: key }, 12345),
    ).toMatchObject({ ok: false });
    // Not a native key at all.
    expect(
      await handler(
        { action: "send_message", text: "x", target: "12345" },
        deriveNumericChatId("12345"),
      ),
    ).toMatchObject({ ok: false });
    // Only plain sends adopt.
    expect(
      await handler(
        { action: "react", message_id: "1", target: key },
        deriveNumericChatId(key),
      ),
    ).toMatchObject({ ok: false });
    expect(chats.get(key)).toBeUndefined();
  });
});

describe("native settings", () => {
  function fakeConfig(): TalonConfig {
    return {
      backend: "claude",
      frontend: "native",
      model: "default",
      botDisplayName: "Talon",
      timezone: "UTC",
      pulse: true,
      pulseIntervalMs: 300000,
      heartbeat: true,
      heartbeatIntervalMinutes: 60,
      dream: true,
    } as unknown as TalonConfig;
  }

  it("snapshot exposes the editable keys and curated fields", () => {
    const snap = configSnapshot(fakeConfig());
    expect(snap.backend).toBe("claude");
    expect(snap.botDisplayName).toBe("Talon");
    expect(snap.editable).toEqual([...EDITABLE]);
    expect(typeof snap.health.uptimeMs).toBe("number");
  });

  it("ignores non-editable keys (no mutation, no write)", () => {
    const config = fakeConfig();
    // `backend` is intentionally NOT editable through the bridge.
    const snap = applyConfigUpdate(config, { backend: "codex" });
    expect(config.backend).toBe("claude");
    expect(snap.backend).toBe("claude");
  });
});

describe("native mesh registry", () => {
  it("upserts devices, applies presence timeout, and persists last-known locations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-"));
    const registry = new MeshRegistry({
      devices: join(dir, "mesh-devices.json"),
      locations: join(dir, "mesh-locations.json"),
      history: join(dir, "mesh-history.json"),
    });

    await registry.register(
      {
        id: "phone",
        name: "Pixel",
        platform: "android",
        appVersion: "1.0.0",
        battery: 88,
        charging: true,
      },
      1_000,
    );
    await registry.register(
      {
        id: "phone",
        name: "Pixel 9",
        platform: "android",
        appVersion: "1.0.1",
        battery: 77,
      },
      2_000,
    );
    await registry.storeLocation(
      {
        deviceId: "phone",
        lat: 53.1,
        lon: -6.2,
        accuracyM: 12,
        ts: 2_100,
        provider: "gps",
      },
      2_100,
    );

    expect(registry.list(2_500).devices).toMatchObject([
      { id: "phone", name: "Pixel 9", online: true, battery: 77 },
    ]);
    // Still online just under the 180s presence window, offline just past it.
    expect(registry.list(180_000).devices[0].online).toBe(true);
    expect(registry.list(183_001).devices[0].online).toBe(false);

    const reloaded = new MeshRegistry({
      devices: join(dir, "mesh-devices.json"),
      locations: join(dir, "mesh-locations.json"),
      history: join(dir, "mesh-history.json"),
    });
    await reloaded.load();
    expect(reloaded.getLocation("phone")).toMatchObject({
      deviceId: "phone",
      lat: 53.1,
      lon: -6.2,
    });
    if (process.platform !== "win32") {
      expect((await stat(join(dir, "mesh-devices.json"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await stat(join(dir, "mesh-locations.json"))).mode & 0o777).toBe(
        0o600,
      );
    }
  });
});

describe("native mesh bridge routes", () => {
  function status(): BridgeStatus {
    return {
      app: "talon-bridge",
      protocol: 1,
      capabilities: ["mesh", "mesh-commands"],
      botName: "Talon",
      backend: "test",
      model: "m1",
      activeChats: 0,
      startedAt: "now",
    };
  }

  async function startMeshServer(token = "secret") {
    const dir = await mkdtemp(join(tmpdir(), "talon-mesh-routes-"));
    const registry = new MeshRegistry({
      devices: join(dir, "devices.json"),
      locations: join(dir, "locations.json"),
      history: join(dir, "history.json"),
    });
    const transfers = new TransferStore();
    const handlers: BridgeServerHandlers = {
      status,
      listChats: () => [],
      createChat: () => {
        throw new Error("unused");
      },
      renameChat: () => null,
      deleteChat: () => false,
      history: () => [],
      search: () => [],
      listMemory: () => ({ ok: true, rows: [] }),
      memoryWhy: () => null,
      send: () => {},
      upload: async () => ({
        path: "",
        name: "",
        size: 0,
        mimeType: "application/octet-stream",
        url: "",
        image: false,
      }),
      listModels: () => ({ active: "", models: [] }),
      setModel: () => {},
      listBackends: () => ({ active: "", backends: [] }),
      setBackend: async () => ({ ok: true }),
      setEffort: () => {},
      effortLevels: async () => ({ active: "", levels: [] }),
      resetChat: () => false,
      interruptTurn: async () => false,
      setPulse: () => {},
      queueMessage: () => {},
      getConfig: () => ({}) as never,
      setConfig: () => ({}) as never,
      listPlugins: () => [],
      setPluginEnabled: async () => ({ ok: true }),
      listSkills: () => [],
      setSkillEnabled: () => ({ ok: true }),
      control: async () => ({ ok: true, message: "" }),
      logs: () => [],
      liveTurnEvents: () => [],
      listCommands: () => [],
      mediaPath: () => null,
      registerDevice: (body) => registry.register(body),
      storeLocation: (body) => registry.storeLocation(body),
      listDevices: () => registry.list(),
      completeCommand: () => false,
      acceptFileUpload: (t, body, from) =>
        transfers.acceptUpload(t, body, from),
      openFileDownload: (t, from) => transfers.openDownload(t, from),
      openNodeInstall: () => null,
      openCompanionPair: () => null,
      openNodeBinary: () => null,
      openSecretDrop: () => null,
      isLiveSecretDrop: () => false,
      submitSecretDrop: async () => ({ status: 404, html: "" }),
    };
    const server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token, startedAt: "now" },
      handlers,
    );
    const port = await server.start();
    return { server, port, transfers, dir };
  }

  it("advertises mesh in health and auth-protects mesh routes", async () => {
    const { server, port } = await startMeshServer();
    try {
      // Capability advertisement is for paired clients — the pre-auth
      // /health body stays down to pairing essentials.
      const probe = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await probe.json()).not.toHaveProperty("capabilities");

      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: "Bearer secret" },
      });
      expect(await health.json()).toMatchObject({
        capabilities: ["mesh", "mesh-commands", "mesh-file-stream"],
      });

      const denied = await fetch(`http://127.0.0.1:${port}/devices`);
      expect(denied.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it("streams a pull upload and a push download through /devices/file", async () => {
    const { server, port, transfers, dir } = await startMeshServer();
    try {
      const auth = { Authorization: "Bearer secret" };

      // Pull: daemon arranges a token, "device" streams the body up.
      const dest = join(dir, "pulled.bin");
      const pull = transfers.createPull("dev1", dest);
      const payload = Buffer.alloc(3 * 1024 * 1024, 7); // 3MB, no chunking
      const up = await fetch(
        `http://127.0.0.1:${port}/devices/file?transfer=${pull.token}`,
        { method: "POST", headers: auth, body: payload },
      );
      expect(up.status).toBe(200);
      expect(await up.json()).toMatchObject({
        ok: true,
        bytes: payload.length,
      });
      await expect(pull.done).resolves.toEqual({
        bytes: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
      });
      const onDisk = await readFile(dest);
      expect(onDisk.equals(payload)).toBe(true);

      // Token is single-use: a replay is rejected.
      const replay = await fetch(
        `http://127.0.0.1:${port}/devices/file?transfer=${pull.token}`,
        { method: "POST", headers: auth, body: payload },
      );
      expect(replay.status).toBe(409);

      // Push: daemon binds a source file, "device" streams it down.
      const src = join(dir, "source.bin");
      await fsWriteFile(src, payload);
      const push = transfers.createPush("dev1", src);
      const down = await fetch(
        `http://127.0.0.1:${port}/devices/file?transfer=${push.token}`,
        { headers: auth },
      );
      expect(down.status).toBe(200);
      expect(down.headers.get("content-length")).toBe(String(payload.length));
      const body = Buffer.from(await down.arrayBuffer());
      expect(body.equals(payload)).toBe(true);

      // Unknown token 404s; unauthenticated request is rejected first.
      const unknown = await fetch(
        `http://127.0.0.1:${port}/devices/file?transfer=nope`,
        { headers: auth },
      );
      expect(unknown.status).toBe(404);
      const unauthed = await fetch(
        `http://127.0.0.1:${port}/devices/file?transfer=nope`,
      );
      expect(unauthed.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it("refuses a transfer token redeemed by a device it wasn't minted for", async () => {
    const { server, port, transfers, dir } = await startMeshServer();
    try {
      const auth = { Authorization: "Bearer secret" };
      const payload = Buffer.alloc(1024, 3);

      // A token minted for dev1 is not a capability another mesh member can
      // use, even holding the (shared) bridge bearer token.
      const dest = join(dir, "bound.bin");
      const pull = transfers.createPull("dev1", dest);
      const stolen = await fetch(
        `http://127.0.0.1:${port}/devices/file?transfer=${pull.token}&deviceId=dev2`,
        { method: "POST", headers: auth, body: payload },
      );
      expect(stolen.status).toBe(409);
      // …and the rejected attempt must not have burned the real device's
      // single-use token.
      const real = await fetch(
        `http://127.0.0.1:${port}/devices/file?transfer=${pull.token}&deviceId=dev1`,
        { method: "POST", headers: auth, body: payload },
      );
      expect(real.status).toBe(200);
      await expect(pull.done).resolves.toEqual({
        bytes: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
      });

      const src = join(dir, "bound-src.bin");
      await fsWriteFile(src, payload);
      const push = transfers.createPush("dev1", src);
      const stolenDown = await fetch(
        `http://127.0.0.1:${port}/devices/file?transfer=${push.token}&deviceId=dev2`,
        { headers: auth },
      );
      expect(stolenDown.status).toBe(404);
      const realDown = await fetch(
        `http://127.0.0.1:${port}/devices/file?transfer=${push.token}&deviceId=dev1`,
        { headers: auth },
      );
      expect(realDown.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("registers devices, stores last-known location, and returns route shapes", async () => {
    const { server, port } = await startMeshServer();
    const headers = {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    };
    try {
      const reg = await fetch(`http://127.0.0.1:${port}/devices/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "phone",
          name: "Pixel",
          platform: "android",
          appVersion: "1.0.0",
        }),
      });
      expect(await reg.json()).toEqual({ ok: true, deviceId: "phone" });

      const loc = await fetch(`http://127.0.0.1:${port}/location`, {
        method: "POST",
        headers,
        body: JSON.stringify({ deviceId: "phone", lat: 1, lon: 2, ts: 3 }),
      });
      expect(await loc.json()).toEqual({ ok: true });

      const list = await fetch(`http://127.0.0.1:${port}/devices`, { headers });
      expect(await list.json()).toMatchObject({
        devices: [{ id: "phone", online: true }],
        locations: [{ deviceId: "phone", lat: 1, lon: 2, ts: 3 }],
      });
    } finally {
      await server.stop();
    }
  });
});

describe("summarizeToolResult", () => {
  it("passes a plain string through, trimmed", () => {
    expect(summarizeToolResult("  hello  ")).toBe("hello");
  });

  it("extracts MCP text content parts", () => {
    const result = {
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
        { type: "image", data: "…" },
      ],
    };
    expect(summarizeToolResult(result)).toBe("line one\nline two");
  });

  it("falls back to pretty JSON for other shapes", () => {
    const out = summarizeToolResult({ ok: true, count: 2 });
    expect(out).toContain('"ok": true');
    expect(out).toContain('"count": 2');
  });

  it("returns undefined for empty / nullish results", () => {
    expect(summarizeToolResult(null)).toBeUndefined();
    expect(summarizeToolResult(undefined)).toBeUndefined();
    expect(summarizeToolResult("   ")).toBeUndefined();
  });

  it("truncates very long output", () => {
    const out = summarizeToolResult("x".repeat(5000));
    expect(out!.length).toBeLessThan(5000);
    expect(out!.endsWith("… (truncated)")).toBe(true);
  });
});
