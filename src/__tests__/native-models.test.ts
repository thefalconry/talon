/**
 * The native bridge's model / backend / effort pickers — what the companion
 * app's model sheet talks to.
 *
 * Every one of these reads the *persisted* per-chat setting before the live
 * pool binding (see `toClientChat`), boots a backend only when one isn't
 * already pooled, and must answer with a value rather than throwing: these
 * calls cross the wire as JSON. The backend controller and the reasoning
 * helper are stubbed; the chat-settings store is the real (per-worker,
 * throwaway) SQLite one, so "what got persisted" is a real assertion.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/engine/backend-controller/index.js", () => ({
  getBackendForChat: vi.fn(() => null),
  getBackendIdForChat: vi.fn(() => "claude"),
  getPooledBackend: vi.fn(() => null),
  acquireBackendInstance: vi.fn(),
  listAvailableBackends: vi.fn(() => [
    { id: "claude", label: "Claude" },
    { id: "kilo", label: "Kilo" },
  ]),
  rebindChat: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../frontend/presentation/reasoning-levels.js", () => ({
  getActiveReasoningLevels: vi.fn(async () => ({ levels: [] })),
}));

import {
  acquireBackendInstance,
  getBackendIdForChat,
  getPooledBackend,
  rebindChat,
} from "../core/engine/backend-controller/index.js";
import { getActiveReasoningLevels } from "../frontend/presentation/reasoning-levels.js";
import {
  effortLevels,
  listBackends,
  listModels,
  setBackend,
  setEffort,
  setModel,
} from "../frontend/native/surface/models.js";
import {
  getChatSettings,
  getChatModelForBackend,
  setChatBackend,
  setChatModelForBackend,
} from "../storage/chat-settings.js";
import { getRecentHistory, pushMessage } from "../storage/history.js";
import { BOT_SENDER_ID } from "../frontend/native/protocol.js";
import { makeNativeHarness } from "./helpers/native-bridge.js";

/** A backend instance whose catalog answers with `models`. */
function catalogOf(models: unknown[]) {
  return { models: { listModels: vi.fn(async () => ({ models })) } };
}

const CLAUDE_MODELS = [
  {
    id: "sonnet",
    displayName: "Sonnet",
    provider: "anthropic",
    selectable: true,
    supportedReasoningLevels: ["low", "high"],
  },
  {
    id: "legacy",
    displayName: "Legacy",
    provider: "anthropic",
    selectable: false,
  },
  {
    id: "plain",
    displayName: "Plain",
    provider: "anthropic",
    selectable: true,
  },
];

let harness: ReturnType<typeof makeNativeHarness>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBackendIdForChat).mockReturnValue("claude");
  vi.mocked(getPooledBackend).mockReturnValue(null as never);
  vi.mocked(rebindChat).mockResolvedValue({ ok: true } as never);
  harness = makeNativeHarness();
});

describe("listModels", () => {
  it("answers with the global default and no models when nothing can be booted", async () => {
    vi.mocked(acquireBackendInstance).mockRejectedValue(new Error("no binary"));
    await expect(listModels(harness.runtime)).resolves.toEqual({
      active: "test-model",
      models: [],
    });
  });

  it("lists only the selectable models of the pooled backend", async () => {
    vi.mocked(getPooledBackend).mockReturnValue(
      catalogOf(CLAUDE_MODELS) as never,
    );
    const { models } = await listModels(harness.runtime);
    expect(models.map((m) => m.id)).toEqual(["sonnet", "plain"]);
  });

  it("flags a model that advertises reasoning levels", async () => {
    vi.mocked(getPooledBackend).mockReturnValue(
      catalogOf(CLAUDE_MODELS) as never,
    );
    const { models } = await listModels(harness.runtime);
    expect(models.map((m) => m.reasoning)).toEqual([true, false]);
  });

  it("lists the chat's own persisted backend, not the global default", async () => {
    const entry = harness.runtime.chats.create();
    setChatBackend(entry.id, "kilo");
    setChatModelForBackend(entry.id, "kilo", "kilo/fast");
    vi.mocked(getPooledBackend).mockReturnValue(catalogOf([]) as never);

    const { active } = await listModels(harness.runtime, entry.id);
    expect(getPooledBackend).toHaveBeenCalledWith("kilo");
    expect(active).toBe("kilo/fast");
  });

  it("keeps the global defaults when the pool is not ready for that chat", async () => {
    const entry = harness.runtime.chats.create();
    vi.mocked(getBackendIdForChat).mockImplementation(() => {
      throw new Error("pool not ready");
    });
    vi.mocked(getPooledBackend).mockReturnValue(catalogOf([]) as never);

    await expect(listModels(harness.runtime, entry.id)).resolves.toMatchObject({
      active: "test-model",
    });
  });

  it("releases a backend it booted transiently so no instance leaks", async () => {
    const release = vi.fn(async () => {});
    vi.mocked(acquireBackendInstance).mockResolvedValue({
      backend: catalogOf(CLAUDE_MODELS),
      release,
    } as never);

    await listModels(harness.runtime);
    expect(release).toHaveBeenCalledOnce();
  });

  it("answers with no models when the backend has no catalog at all", async () => {
    vi.mocked(getPooledBackend).mockReturnValue({} as never);
    await expect(listModels(harness.runtime)).resolves.toMatchObject({
      models: [],
    });
  });

  it("answers with no models when listing throws, and still releases", async () => {
    const release = vi.fn(async () => {});
    vi.mocked(acquireBackendInstance).mockResolvedValue({
      backend: {
        models: {
          listModels: vi.fn(async () => {
            throw new Error("catalog unreachable");
          }),
        },
      },
      release,
    } as never);

    await expect(listModels(harness.runtime)).resolves.toMatchObject({
      models: [],
    });
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("setModel", () => {
  it("ignores a chat the registry does not know", () => {
    const { runtime, events } = harness;
    setModel(runtime, "d_missing", "sonnet");
    expect(events).toHaveLength(0);
  });

  it("persists the pick under the chat's persisted backend", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    setChatBackend(entry.id, "kilo");
    setModel(runtime, entry.id, "  kilo/fast  ");

    expect(getChatModelForBackend(entry.id, "kilo")).toBe("kilo/fast");
  });

  it("syncs the new pick to clients", () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    setModel(runtime, entry.id, "sonnet");
    expect(eventsOf("chat_updated")).toMatchObject([
      { chat: { id: entry.id, model: "sonnet" } },
    ]);
  });

  it("falls back to the global backend when the pool is not ready", () => {
    // The three readers beside it all guard this lookup; unguarded, an
    // early-boot pick 400s the route and is lost instead of persisted.
    const { runtime } = harness;
    const entry = runtime.chats.create();
    vi.mocked(getBackendIdForChat).mockImplementation(() => {
      throw new Error("pool not ready");
    });

    expect(() => setModel(runtime, entry.id, "sonnet")).not.toThrow();
    expect(getChatModelForBackend(entry.id, "claude")).toBe("sonnet");
  });

  it("clears the pick when the model is blank", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    setModel(runtime, entry.id, "sonnet");
    setModel(runtime, entry.id, "   ");
    expect(getChatModelForBackend(entry.id, "claude")).toBeUndefined();
  });
});

describe("listBackends", () => {
  it("reports the chat's persisted backend as active", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    setChatBackend(entry.id, "kilo");

    expect(listBackends(runtime, entry.id)).toEqual({
      active: "kilo",
      backends: [
        { id: "claude", label: "Claude" },
        { id: "kilo", label: "Kilo" },
      ],
    });
  });

  it("falls back to the global backend when the pool is not ready", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    vi.mocked(getBackendIdForChat).mockImplementation(() => {
      throw new Error("pool not ready");
    });
    expect(listBackends(runtime, entry.id).active).toBe("claude");
  });
});

describe("setBackend", () => {
  it("refuses a chat the registry does not know", async () => {
    await expect(
      setBackend(harness.runtime, "d_missing", "kilo"),
    ).resolves.toEqual({ ok: false, error: "No such chat" });
  });

  it("refuses a backend that is not on the available list", async () => {
    const entry = harness.runtime.chats.create();
    await expect(
      setBackend(harness.runtime, entry.id, "gemini"),
    ).resolves.toEqual({ ok: false, error: "Backend not available" });
  });

  it("surfaces a failed rebind as an error rather than throwing", async () => {
    const entry = harness.runtime.chats.create();
    vi.mocked(rebindChat).mockResolvedValue({
      ok: false,
      error: "kilo is not logged in",
    } as never);

    await expect(
      setBackend(harness.runtime, entry.id, "kilo"),
    ).resolves.toEqual({ ok: false, error: "kilo is not logged in" });
  });

  it("names a rebind failure that gave no reason", async () => {
    const entry = harness.runtime.chats.create();
    vi.mocked(rebindChat).mockResolvedValue({ ok: false } as never);

    await expect(
      setBackend(harness.runtime, entry.id, "kilo"),
    ).resolves.toEqual({ ok: false, error: "Rebind failed" });
  });

  it("only persists the choice when the chat is already live on it", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    vi.mocked(getBackendIdForChat).mockReturnValue("kilo");

    await expect(setBackend(runtime, entry.id, "kilo")).resolves.toEqual({
      ok: true,
    });
    expect(getChatSettings(entry.id).backend).toBe("kilo");
    expect(rebindChat).not.toHaveBeenCalled();
  });

  it("keeps the conversation when the chat moves to another backend", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    pushMessage(entry.id, {
      msgId: 1,
      senderId: BOT_SENDER_ID,
      senderName: "Talon",
      text: "on claude",
      timestamp: Date.now(),
    });

    await setBackend(runtime, entry.id, "kilo");

    // A switch changes who answers, not what was said: history stays.
    expect(getRecentHistory(entry.id, 10).map((m) => m.text)).toEqual([
      "on claude",
    ]);
    expect(getChatSettings(entry.id).backend).toBe("kilo");
  });

  it("tells the chat it switched", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    await setBackend(runtime, entry.id, "kilo");

    expect(eventsOf("message")).toMatchObject([
      {
        message: {
          role: "system",
          text: "Switched to kilo — new session, chat history kept.",
        },
      },
    ]);
  });

  it("re-attaching to the chat's own backend keeps the conversation", async () => {
    // A retried pick after a transient boot-time rebind failure is a
    // RE-ATTACH — wiping here destroyed real conversations.
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    setChatBackend(entry.id, "kilo");
    pushMessage(entry.id, {
      msgId: 1,
      senderId: BOT_SENDER_ID,
      senderName: "Talon",
      text: "still here",
      timestamp: Date.now(),
    });

    await expect(setBackend(runtime, entry.id, "kilo")).resolves.toEqual({
      ok: true,
    });
    expect(getRecentHistory(entry.id, 10)).toHaveLength(1);
    expect(eventsOf("message")).toHaveLength(0);
  });

  it("pushes the new daemon status after a switch", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    await setBackend(runtime, entry.id, "kilo");
    expect(eventsOf("status")).toHaveLength(1);
  });
});

describe("setEffort and effortLevels", () => {
  it("ignores a chat the registry does not know", () => {
    const { runtime, events } = harness;
    setEffort(runtime, "d_missing", "high");
    expect(events).toHaveLength(0);
  });

  it("persists a known effort level", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    setEffort(runtime, entry.id, "high");
    expect(getChatSettings(entry.id).effort).toBe("high");
  });

  it("clears the setting when the level is not one Talon knows", () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    setEffort(runtime, entry.id, "high");
    setEffort(runtime, entry.id, "turbo");
    expect(getChatSettings(entry.id).effort).toBeUndefined();
  });

  it("reports the chat's level alongside what the backend supports", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    setEffort(runtime, entry.id, "high");
    vi.mocked(getActiveReasoningLevels).mockResolvedValue({
      levels: ["low", "high"],
    } as never);

    await expect(effortLevels(runtime, entry.id)).resolves.toEqual({
      active: "high",
      levels: ["low", "high"],
    });
  });

  it("defaults to adaptive with no levels when the backend cannot be asked", async () => {
    vi.mocked(getActiveReasoningLevels).mockRejectedValue(
      new Error("pool not ready"),
    );
    await expect(effortLevels(harness.runtime, "d_missing")).resolves.toEqual({
      active: "adaptive",
      levels: [],
    });
  });
});
