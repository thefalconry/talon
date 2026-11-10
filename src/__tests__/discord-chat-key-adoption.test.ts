/**
 * Discord's chat registry is in-memory, so after a restart a channel is
 * unknown until someone speaks in it. A send that names its chat by key
 * (the staged-restore report does) rebuilds the registry entry from the
 * key, so the message can still reach the channel — or the DM — that
 * asked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";

vi.mock("../storage/scheduled.js", () => ({
  saveScheduled: vi.fn(),
  deleteScheduled: vi.fn(),
  listScheduled: vi.fn(() => []),
  listScheduledForChat: vi.fn(() => []),
  MAX_OVERDUE_MS: 60_000,
}));

import { createDiscordActionHandler } from "../frontend/discord/actions/index.js";
import { resolveChannel } from "../frontend/discord/actions/channels.js";
import {
  lookupDiscordChat,
  parseDiscordChatKey,
} from "../frontend/discord/handlers/registry.js";
import {
  chatRegistry,
  chatRegistryByString,
} from "../frontend/discord/handlers/state.js";
import { deriveNumericChatId } from "../core/frontend-runtime/chat-id.js";
import type { Gateway } from "../core/engine/gateway.js";

function sendableChannel(id: string) {
  return {
    id,
    send: vi.fn(async () => ({ id: `m_${id}` })),
    isSendable: () => true,
  };
}

function fakeClient() {
  const channels = new Map<string, ReturnType<typeof sendableChannel>>();
  const dms = new Map<string, ReturnType<typeof sendableChannel>>();
  const client = {
    channels: {
      fetch: vi.fn(async (id: string) => {
        const ch = channels.get(id);
        if (!ch) throw new Error(`Unknown Channel ${id}`);
        return ch;
      }),
    },
    users: {
      fetch: vi.fn(async (userId: string) => ({
        createDM: async () => {
          const dm = dms.get(userId) ?? sendableChannel(`dm_${userId}`);
          dms.set(userId, dm);
          return dm;
        },
      })),
    },
  };
  return { client: client as unknown as Client, raw: client, channels, dms };
}

const gateway = { incrementMessages: vi.fn() } as unknown as Gateway;

beforeEach(() => {
  chatRegistry.clear();
  chatRegistryByString.clear();
});

describe("parseDiscordChatKey", () => {
  it("rebuilds guild channel and DM entries", () => {
    expect(parseDiscordChatKey("discord_guild_111_222")).toEqual({
      channelId: "222",
      guildId: "111",
      userId: null,
      numericChatId: deriveNumericChatId("discord_guild_111_222"),
      chatId: "discord_guild_111_222",
    });
    expect(parseDiscordChatKey("discord_dm_42")).toMatchObject({
      channelId: "",
      guildId: null,
      userId: "42",
    });
  });

  it("refuses anything else", () => {
    for (const key of ["123", "d_1_a", "discord_guild_x_1", "discord_dm_"]) {
      expect(parseDiscordChatKey(key)).toBeUndefined();
    }
  });
});

describe("resolveChannel", () => {
  it("opens a DM by user when the entry has no channel id", async () => {
    const { client, raw } = fakeClient();
    const info = parseDiscordChatKey("discord_dm_42")!;
    chatRegistry.set(info.numericChatId, info);
    const ch = await resolveChannel(client, info.numericChatId);
    expect(ch).toMatchObject({ id: "dm_42" });
    expect(raw.channels.fetch).not.toHaveBeenCalled();
  });
});

describe("Discord action handler, addressed by chat key", () => {
  it("delivers to a guild channel nobody has spoken in since the restart", async () => {
    const { client, channels } = fakeClient();
    const channel = sendableChannel("222");
    channels.set("222", channel);
    const handler = createDiscordActionHandler(client, gateway);
    const key = "discord_guild_111_222";

    const res = await handler(
      { action: "send_message", text: "♻️ Restored", target: key },
      deriveNumericChatId(key),
    );
    expect(res).toMatchObject({ ok: true });
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: "♻️ Restored" }),
    );
    expect(lookupDiscordChat(deriveNumericChatId(key))?.chatId).toBe(key);
  });

  it("delivers to a DM rebuilt from its key", async () => {
    const { client, dms } = fakeClient();
    const handler = createDiscordActionHandler(client, gateway);
    const key = "discord_dm_42";
    const res = await handler(
      { action: "send_message", text: "♻️ Restored", target: key },
      deriveNumericChatId(key),
    );
    expect(res).toMatchObject({ ok: true });
    expect(dms.get("42")?.send).toHaveBeenCalled();
  });

  it("adopts nothing when the key doesn't match the id", async () => {
    const { client } = fakeClient();
    const handler = createDiscordActionHandler(client, gateway);
    const res = await handler(
      { action: "send_message", text: "x", target: "discord_dm_42" },
      12345,
    );
    expect(res).toMatchObject({ ok: false });
    expect(lookupDiscordChat(12345)).toBeUndefined();
    expect(lookupDiscordChat(deriveNumericChatId("discord_dm_42"))).toBe(
      undefined,
    );
  });
});
