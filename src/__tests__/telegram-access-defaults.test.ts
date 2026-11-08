/**
 * Telegram access defaults: an unset allowlist or admin must never mean
 * "everyone". Without `allowedUsers` the bot answers only its admin; without
 * an admin nobody is admin, no DM is let in, and no group is trusted.
 */
import { describe, it, expect, vi } from "vitest";
import type { Bot, Context } from "grammy";
import {
  setAccessControl,
  isAccessAllowed,
} from "../frontend/telegram/handlers/access.js";
import {
  setAdminUserId,
  isAuthorizedAdmin,
  isConfiguredAdmin,
} from "../frontend/telegram/commands/state.js";
import { setAllowedGroups } from "../frontend/telegram/handlers/group-access.js";

const ADMIN = 111;
const FRIEND = 222;
const STRANGER = 999;

function makeBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getChatMember: vi.fn().mockResolvedValue({ status: "member" }),
    },
  } as unknown as Bot;
}

function makeCtx(fromId: number, chatType = "private", chatId = fromId) {
  return {
    chat: { id: chatId, type: chatType, title: "group" },
    from: { id: fromId, first_name: "Test", username: "test" },
    message: { text: "hello", message_id: 1 },
  } as unknown as Context;
}

describe("telegram DM allowlist defaults", () => {
  it("defaults to the admin alone when allowedUsers is unset", async () => {
    setAccessControl({ adminUserId: ADMIN });
    const bot = makeBot();
    expect(await isAccessAllowed(makeCtx(ADMIN), bot)).toBe(true);
    expect(await isAccessAllowed(makeCtx(STRANGER), bot)).toBe(false);
  });

  it("treats an empty allowedUsers the same as unset", async () => {
    setAccessControl({ allowedUsers: [], adminUserId: ADMIN });
    expect(await isAccessAllowed(makeCtx(STRANGER), makeBot())).toBe(false);
  });

  it("admits listed users and the admin, denies everyone else", async () => {
    setAccessControl({ allowedUsers: [FRIEND], adminUserId: ADMIN });
    const bot = makeBot();
    expect(await isAccessAllowed(makeCtx(FRIEND), bot)).toBe(true);
    // The admin is always on the list, even when the config forgot them.
    expect(await isAccessAllowed(makeCtx(ADMIN), bot)).toBe(true);
    expect(await isAccessAllowed(makeCtx(STRANGER), bot)).toBe(false);
  });

  it("denies every DM when neither an admin nor an allowlist is set", async () => {
    setAccessControl({});
    expect(await isAccessAllowed(makeCtx(STRANGER), makeBot())).toBe(false);
  });
});

describe("telegram group access without an admin", () => {
  it("denies groups when no admin is configured", async () => {
    setAccessControl({});
    const bot = makeBot();
    expect(
      await isAccessAllowed(makeCtx(STRANGER, "supergroup", -100123), bot),
    ).toBe(false);
    // Denied without even asking Telegram — there is no admin to look for.
    expect(bot.api.getChatMember).not.toHaveBeenCalled();
  });

  it("denies even a listed group when no admin is configured", async () => {
    setAccessControl({});
    setAllowedGroups([-100789]);
    try {
      expect(
        await isAccessAllowed(
          makeCtx(STRANGER, "supergroup", -100789),
          makeBot(),
        ),
      ).toBe(false);
    } finally {
      setAllowedGroups(undefined);
    }
  });

  it("admits a group the admin belongs to", async () => {
    setAccessControl({ adminUserId: ADMIN });
    const bot = makeBot();
    expect(
      await isAccessAllowed(makeCtx(STRANGER, "supergroup", -100456), bot),
    ).toBe(true);
    expect(bot.api.getChatMember).toHaveBeenCalledWith(-100456, ADMIN);
  });
});

describe("telegram admin commands", () => {
  const as = (id: number) => ({ from: { id } }) as unknown as Context;

  it("no admin configured means nobody is admin", () => {
    setAdminUserId(undefined);
    expect(isAuthorizedAdmin(as(STRANGER))).toBe(false);
    expect(isAuthorizedAdmin(as(ADMIN))).toBe(false);
    expect(isConfiguredAdmin(as(STRANGER))).toBe(false);
  });

  it("only the configured admin passes once one is set", () => {
    setAdminUserId(ADMIN);
    expect(isAuthorizedAdmin(as(ADMIN))).toBe(true);
    expect(isAuthorizedAdmin(as(STRANGER))).toBe(false);
    expect(isConfiguredAdmin(as(ADMIN))).toBe(true);
    setAdminUserId(undefined);
  });
});
