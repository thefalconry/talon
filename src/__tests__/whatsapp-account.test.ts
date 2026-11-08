/**
 * WhatsApp account actions — the bot's own profile, privacy, blocklist
 * and presence.
 *
 * The socket is stubbed: these pin the adapter's own logic (which
 * Baileys call an op maps to, what it refuses, how it reports back),
 * not Baileys itself. The chatless contract matters most — every op
 * here must work with no resolved WhatsApp chat, because the session
 * driving them usually lives on another frontend.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { createWhatsAppActionHandler } from "../frontend/whatsapp/actions/index.js";
import { resetWhatsAppRegistry } from "../frontend/whatsapp/registry.js";

describe("WhatsApp account actions", () => {
  const gateway = { incrementMessages: vi.fn() } as never;
  let calls: Array<{ method: string; args: unknown[] }>;
  let sock: never;

  /** Record every socket call so a test can assert the mapping. */
  function spy(method: string, result?: unknown) {
    return vi.fn(async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    });
  }

  beforeEach(() => {
    resetWhatsAppRegistry();
    calls = [];
    sock = {
      user: { id: "447700900101:17@s.whatsapp.net", name: "Claudius" },
      fetchStatus: spy("fetchStatus", [{ status: "Running on Talon" }]),
      profilePictureUrl: spy("profilePictureUrl", "https://wa/pic.jpg"),
      updateProfileName: spy("updateProfileName"),
      updateProfileStatus: spy("updateProfileStatus"),
      updateProfilePicture: spy("updateProfilePicture"),
      removeProfilePicture: spy("removeProfilePicture"),
      fetchPrivacySettings: spy("fetchPrivacySettings", {
        last: "contacts",
        online: "all",
      }),
      updateLastSeenPrivacy: spy("updateLastSeenPrivacy"),
      updateOnlinePrivacy: spy("updateOnlinePrivacy"),
      updateReadReceiptsPrivacy: spy("updateReadReceiptsPrivacy"),
      updateDefaultDisappearingMode: spy("updateDefaultDisappearingMode"),
      fetchBlocklist: spy("fetchBlocklist", ["353871234567@s.whatsapp.net"]),
      updateBlockStatus: spy("updateBlockStatus"),
      sendPresenceUpdate: spy("sendPresenceUpdate"),
    } as never;
  });

  /** Chat id 0 and no target: the chat-free path the gateway uses. */
  function run(body: Record<string, unknown>) {
    return createWhatsAppActionHandler(() => sock, gateway)(
      { action: "whatsapp_account", ...body },
      0,
    );
  }

  const method = (name: string) => calls.find((c) => c.method === name);

  it("reads the account's own profile with no chat resolved", async () => {
    const result = await run({ op: "get_profile" });
    expect(result?.ok).toBe(true);
    const text = String(result?.text);
    expect(text).toContain("number: +447700900101");
    expect(text).toContain("name: Claudius");
    expect(text).toContain("about: Running on Talon");
    expect(text).toContain("photo: https://wa/pic.jpg");
    // The device suffix must be stripped before any profile lookup.
    expect(method("fetchStatus")?.args[0]).toBe("447700900101@s.whatsapp.net");
  });

  it("sets the display name and the about text", async () => {
    expect((await run({ op: "set_name", name: "Talon" }))?.ok).toBe(true);
    expect(method("updateProfileName")?.args[0]).toBe("Talon");

    expect((await run({ op: "set_about", text: "brb" }))?.ok).toBe(true);
    expect(method("updateProfileStatus")?.args[0]).toBe("brb");
  });

  it("treats an empty about as a deliberate clear, not a missing argument", async () => {
    const result = await run({ op: "set_about", text: "" });
    expect(result?.ok).toBe(true);
    expect(String(result?.text)).toContain("cleared");
    expect(method("updateProfileStatus")?.args[0]).toBe("");
  });

  it("requires a name for set_name", async () => {
    const result = await run({ op: "set_name", name: "   " });
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toContain("name is required");
    expect(method("updateProfileName")).toBeUndefined();
  });

  it("sets the profile photo from a URL, addressed to its own JID", async () => {
    const result = await run({
      op: "set_photo",
      url: "https://example.com/avatar.png",
    });
    expect(result?.ok).toBe(true);
    expect(method("updateProfilePicture")?.args).toEqual([
      "447700900101@s.whatsapp.net",
      { url: "https://example.com/avatar.png" },
    ]);
  });

  it("reports a missing photo source instead of failing obscurely", async () => {
    const result = await run({ op: "set_photo" });
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toContain("file_path");
    expect(method("updateProfilePicture")).toBeUndefined();
  });

  it("maps each privacy setting to its own Baileys setter", async () => {
    expect(
      (
        await run({
          op: "set_privacy",
          setting: "last_seen",
          value: "contacts",
        })
      )?.ok,
    ).toBe(true);
    expect(method("updateLastSeenPrivacy")?.args[0]).toBe("contacts");

    expect(
      (
        await run({
          op: "set_privacy",
          setting: "online",
          value: "match_last_seen",
        })
      )?.ok,
    ).toBe(true);
    expect(method("updateOnlinePrivacy")?.args[0]).toBe("match_last_seen");
  });

  it("rejects a value the setting does not accept, and says which it does", async () => {
    // "none" is valid for last_seen but not for online.
    const result = await run({
      op: "set_privacy",
      setting: "online",
      value: "none",
    });
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toContain("match_last_seen");
    expect(method("updateOnlinePrivacy")).toBeUndefined();
  });

  it("names every valid setting when given an unknown one", async () => {
    const result = await run({
      op: "set_privacy",
      setting: "telepathy",
      value: "all",
    });
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toContain("read_receipts");
  });

  it("accepts named and numeric disappearing durations", async () => {
    expect((await run({ op: "set_disappearing", duration: "7d" }))?.ok).toBe(
      true,
    );
    expect(method("updateDefaultDisappearingMode")?.args[0]).toBe(604800);

    calls = [];
    expect((await run({ op: "set_disappearing", duration: "3600" }))?.ok).toBe(
      true,
    );
    expect(method("updateDefaultDisappearingMode")?.args[0]).toBe(3600);

    calls = [];
    const bad = await run({ op: "set_disappearing", duration: "soon" });
    expect(bad?.ok).toBe(false);
    expect(method("updateDefaultDisappearingMode")).toBeUndefined();
  });

  it("blocks and unblocks by phone number", async () => {
    expect((await run({ op: "block", contact: "+353 87 123 4567" }))?.ok).toBe(
      true,
    );
    expect(method("updateBlockStatus")?.args).toEqual([
      "353871234567@s.whatsapp.net",
      "block",
    ]);

    calls = [];
    await run({ op: "unblock", contact: "353871234567" });
    expect(method("updateBlockStatus")?.args[1]).toBe("unblock");
  });

  it("lists the blocklist and the current privacy settings", async () => {
    expect(String((await run({ op: "get_blocklist" }))?.text)).toContain(
      "353871234567",
    );
    expect(String((await run({ op: "get_privacy" }))?.text)).toContain(
      "last: contacts",
    );
  });

  it("broadcasts presence, and refuses anything but the two valid states", async () => {
    expect(
      (await run({ op: "set_presence", presence: "unavailable" }))?.ok,
    ).toBe(true);
    expect(method("sendPresenceUpdate")?.args[0]).toBe("unavailable");

    calls = [];
    const bad = await run({ op: "set_presence", presence: "invisible" });
    expect(bad?.ok).toBe(false);
    expect(method("sendPresenceUpdate")).toBeUndefined();
  });

  it("names every op when given an unknown one", async () => {
    const result = await run({ op: "become_president" });
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toContain("get_profile");
  });

  it("surfaces a Baileys failure as a structured error, not a throw", async () => {
    sock = {
      ...(sock as object),
      updateProfileName: vi.fn(async () => {
        throw new Error("rate-overlimit");
      }),
    } as never;
    const result = await run({ op: "set_name", name: "Talon" });
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toContain("rate-overlimit");
  });

  it("still refuses when the socket is not connected", async () => {
    const handle = createWhatsAppActionHandler(() => null, gateway);
    const result = await handle(
      { action: "whatsapp_account", op: "get_profile" },
      0,
    );
    expect(result).toEqual({
      ok: false,
      error: "WhatsApp socket is not connected",
    });
  });
});
