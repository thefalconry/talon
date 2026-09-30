/**
 * Every frontend's `/backup restore` records who asked — the chat key and
 * the frontend — so the boot that applies the restore can report back to
 * that chat rather than only to the admin's primary one. (Native's is
 * covered with the rest of its slash commands in native-commands.test.ts.)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { writeRestorePending, respawnSelf } = vi.hoisted(() => ({
  writeRestorePending: vi.fn(async () => {}),
  respawnSelf: vi.fn(),
}));
vi.mock("../core/backup/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/backup/index.js")>()),
  writeRestorePending,
}));
vi.mock("../core/daemon/respawn.js", () => ({ respawnSelf }));
vi.mock("../frontend/discord/handlers/index.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../frontend/discord/handlers/index.js")
  >()),
  isAdmin: () => true,
}));

import { stageRestore } from "../frontend/telegram/commands/backup.js";
import { handleBackupComponent } from "../frontend/discord/commands/backup.js";
import type { ComponentInteraction } from "../frontend/discord/callbacks/components/types.js";

const ID = "20260930T120000Z-abc123";

beforeEach(() => {
  writeRestorePending.mockClear();
  respawnSelf.mockClear();
});

describe("staging a restore records the requesting chat and frontend", () => {
  it("on Telegram", async () => {
    await stageRestore("-100123", ID);
    expect(writeRestorePending).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        requestedBy: "-100123",
        frontend: "telegram",
      }),
    );
    expect(respawnSelf).toHaveBeenCalled();
  });

  it.each([
    ["a guild channel", "111", "discord_guild_111_222"],
    ["a DM", null, "discord_dm_42"],
  ])("on Discord, from %s", async (_label, guildId, key) => {
    const interaction = {
      customId: `backup:restore:${ID}`,
      user: { id: "42" },
      guildId,
      channelId: "222",
      update: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as unknown as ComponentInteraction;
    expect(await handleBackupComponent(interaction)).toBe(true);
    expect(writeRestorePending).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        requestedBy: key,
        frontend: "discord",
      }),
    );
    expect(respawnSelf).toHaveBeenCalled();
  });
});
