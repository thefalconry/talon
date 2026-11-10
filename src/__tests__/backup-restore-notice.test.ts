/**
 * Reporting a staged restore back to the chat that asked for it.
 *
 * The restore runs in the boot before any frontend exists; once they are
 * up, the confirmation goes to the requesting chat on its own frontend
 * (through the cross-send broker every enabled frontend registers on),
 * and to the admin's primary chat only when that chat can't be reached or
 * the request never said who asked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPendingRestore,
  writeRestorePending,
  type RestorePending,
} from "../core/backup/restore.js";
import { buildSnapshot } from "../core/backup/snapshot.js";
import { resolveBackupSettings } from "../core/backup/plan.js";
import {
  deliverRestoreNotice,
  formatRestoreNotice,
  requesterFrontend,
} from "../core/backup/restore/notice.js";
import { registerCrossSendTarget } from "../core/engine/gateway-actions/cross-send.js";
import { deriveNumericChatId } from "../core/frontend-runtime/chat-id.js";
import type { FrontendActionHandler } from "../core/types.js";

const SETTINGS = resolveBackupSettings({ includePalace: false });
const noSleep = async () => {};

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "talon-restore-notice-"));
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "workspace", "memory"), { recursive: true });
  writeFileSync(join(root, "config.json"), '{"model":"original"}');
  writeFileSync(join(root, "prompts", "system.md"), "prompt");
  writeFileSync(join(root, "workspace", "memory", "memory.md"), "memory");
  writeFileSync(join(root, "data", "talon.db"), "live database");
  return root;
}

/** Stage a restore the way a /backup command does and run the boot hook. */
async function stageAndApply(
  request: Omit<RestorePending, "id" | "requestedAt">,
) {
  const root = home();
  const snapshot = await buildSnapshot({
    kind: "checkpoint",
    label: "known good",
    settings: SETTINGS,
    home: root,
    copyDatabase: (dest) => writeFileSync(dest, "SQLite format 3\0snapshot"),
  });
  await writeRestorePending(
    { id: snapshot.id, requestedAt: Date.now(), ...request },
    root,
  );
  const report = await applyPendingRestore({ settings: SETTINGS, home: root });
  expect(report?.id).toBe(snapshot.id);
  return report!;
}

/** A fake frontend on the broker, recording what it was asked to send. */
function fakeFrontend(name: string, ok = true) {
  const handler = vi.fn<FrontendActionHandler>(async () =>
    ok ? { ok: true } : { ok: false, error: "unreachable" },
  );
  registerCrossSendTarget(name, handler);
  return handler;
}

const registered = ["telegram", "discord", "native"];
afterEach(() => {
  for (const name of registered) registerCrossSendTarget(name, null);
});

describe("requesterFrontend", () => {
  it("prefers the recorded frontend", () => {
    expect(
      requesterFrontend({ requestedBy: "12345", frontend: "Discord" }),
    ).toBe("discord");
  });

  it("infers it from the chat key when the request predates the field", () => {
    expect(requesterFrontend({ requestedBy: "-100123" })).toBe("telegram");
    expect(requesterFrontend({ requestedBy: "d_1700000000000_abc" })).toBe(
      "native",
    );
    expect(requesterFrontend({ requestedBy: "discord_dm_42" })).toBe("discord");
    expect(requesterFrontend({ requestedBy: "wa_dm_1" })).toBeUndefined();
    expect(requesterFrontend({})).toBeUndefined();
  });
});

describe("a staged restore reports to the chat that requested it", () => {
  const cases = [
    { frontend: "telegram", requestedBy: "123456789", numeric: 123456789 },
    {
      frontend: "discord",
      requestedBy: "discord_guild_111_222",
      numeric: deriveNumericChatId("discord_guild_111_222"),
    },
    {
      frontend: "native",
      requestedBy: "d_1700000000000_abcdef",
      numeric: deriveNumericChatId("d_1700000000000_abcdef"),
    },
  ];

  for (const { frontend, requestedBy, numeric } of cases) {
    it(`from ${frontend}`, async () => {
      const handlers = Object.fromEntries(
        registered.map((name) => [name, fakeFrontend(name)]),
      );
      const report = await stageAndApply({ requestedBy, frontend });
      expect(report).toMatchObject({ requestedBy, frontend });

      const notifyAdmin = vi.fn(async () => true);
      const text = formatRestoreNotice(report);
      const where = await deliverRestoreNotice({
        text,
        requester: report,
        notifyAdmin,
        sleep: noSleep,
      });

      expect(where).toBe("requester");
      expect(text).toContain(`♻️ Restored snapshot ${report.id}`);
      expect(text).toContain(report.checkpointId!);
      expect(handlers[frontend]).toHaveBeenCalledWith(
        { action: "send_message", text, target: requestedBy },
        numeric,
      );
      for (const other of registered.filter((n) => n !== frontend)) {
        expect(handlers[other]).not.toHaveBeenCalled();
      }
      expect(notifyAdmin).not.toHaveBeenCalled();
    });
  }

  it("from a pending file written before the frontend was recorded", async () => {
    const telegram = fakeFrontend("telegram");
    const report = await stageAndApply({ requestedBy: "987654321" });
    expect(report.frontend).toBeUndefined();

    const notifyAdmin = vi.fn(async () => true);
    const where = await deliverRestoreNotice({
      text: formatRestoreNotice(report),
      requester: report,
      notifyAdmin,
      sleep: noSleep,
    });
    expect(where).toBe("requester");
    expect(telegram).toHaveBeenCalledWith(
      expect.objectContaining({ action: "send_message" }),
      987654321,
    );
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

describe("falling back to the admin's primary chat", () => {
  it("when the request never said who asked", async () => {
    const telegram = fakeFrontend("telegram");
    const report = await stageAndApply({});
    const notifyAdmin = vi.fn(async () => true);
    const text = formatRestoreNotice(report);
    const where = await deliverRestoreNotice({
      text,
      requester: report,
      notifyAdmin,
      sleep: noSleep,
    });
    expect(where).toBe("admin");
    expect(notifyAdmin).toHaveBeenCalledWith(text);
    expect(telegram).not.toHaveBeenCalled();
  });

  it("when the requester's key belongs to no known frontend", async () => {
    const notifyAdmin = vi.fn(async () => true);
    const where = await deliverRestoreNotice({
      text: "♻️ Restored snapshot x",
      requester: { requestedBy: "wa_dm_353000" },
      notifyAdmin,
      sleep: noSleep,
    });
    expect(where).toBe("admin");
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  it("when the requester's frontend is not enabled", async () => {
    const telegram = fakeFrontend("telegram");
    const send = vi.fn(async () => true);
    const notifyAdmin = vi.fn(async () => true);
    const where = await deliverRestoreNotice({
      text: "♻️ Restored snapshot x",
      requester: { requestedBy: "discord_dm_42", frontend: "discord" },
      notifyAdmin,
      send,
      sleep: noSleep,
    });
    expect(where).toBe("admin");
    // No retrying a frontend that isn't there.
    expect(send).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  it("when delivery to the requester keeps failing", async () => {
    const native = fakeFrontend("native", false);
    const sleep = vi.fn(noSleep);
    const notifyAdmin = vi.fn(async () => true);
    const where = await deliverRestoreNotice({
      text: "♻️ Restored snapshot x",
      requester: { requestedBy: "d_1_a", frontend: "native" },
      notifyAdmin,
      attempts: 3,
      sleep,
    });
    expect(where).toBe("admin");
    expect(native).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(notifyAdmin).toHaveBeenCalledWith("♻️ Restored snapshot x");
  });

  it("retries a frontend that is still connecting, then delivers", async () => {
    let calls = 0;
    registerCrossSendTarget("discord", async () =>
      ++calls < 3 ? { ok: false, error: "not ready" } : { ok: true },
    );
    const notifyAdmin = vi.fn(async () => true);
    const where = await deliverRestoreNotice({
      text: "♻️ Restored snapshot x",
      requester: { requestedBy: "discord_dm_42", frontend: "discord" },
      notifyAdmin,
      sleep: noSleep,
    });
    expect(where).toBe("requester");
    expect(calls).toBe(3);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it("when a send throws", async () => {
    registerCrossSendTarget("telegram", async () => {
      throw new Error("chat not found");
    });
    const notifyAdmin = vi.fn(async () => true);
    const where = await deliverRestoreNotice({
      text: "♻️ Restored snapshot x",
      requester: { requestedBy: "123", frontend: "telegram" },
      notifyAdmin,
      attempts: 2,
      sleep: noSleep,
    });
    expect(where).toBe("admin");
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });
});
