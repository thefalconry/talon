/**
 * The Telegram /backup panel: the status panel and its keyboard, Back up
 * now editing in place, snapshot paging, pin/unpin, the restore button
 * leading to the confirmation (never straight to a restore), and the
 * admin re-check on every tap. The backup subsystem is mocked; nothing
 * here builds a snapshot or respawns the process.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Bot, Context } from "grammy";
import type { BackupStatus, SnapshotSummary } from "../core/backup/index.js";

const backup = {
  collectBackupStatus: vi.fn<() => Promise<BackupStatus>>(),
  listSnapshots: vi.fn<() => Promise<SnapshotSummary[]>>(),
  readManifest: vi.fn(),
  runBackup: vi.fn(),
  setSnapshotPinned: vi.fn<(id: string, pinned: boolean) => Promise<boolean>>(),
  writeRestorePending: vi.fn(),
};
vi.mock("../core/backup/index.js", async (orig) => ({
  ...(await orig<object>()),
  ...backup,
}));
const respawnSelf = vi.fn();
vi.mock("../core/daemon/respawn.js", async (orig) => ({
  ...(await orig<object>()),
  respawnSelf,
}));

const { handleBackupCallback, _resetBackupPanelState } =
  await import("../frontend/telegram/callbacks/backup.js");
const { registerBackupCommand } =
  await import("../frontend/telegram/commands/backup.js");
const { setAdminUserId } =
  await import("../frontend/telegram/commands/state.js");
const { parseBackupAction, SNAPSHOT_PAGE_SIZE } =
  await import("../frontend/presentation/backup-panel.js");

const ADMIN = 111;
const OTHER = 222;
const NOW = Date.parse("2026-09-30T17:14:00Z");

function snapshot(
  n: number,
  over: Partial<SnapshotSummary> = {},
): SnapshotSummary {
  const at = NOW - (n + 1) * 3_600_000;
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return {
    id: `${stamp}-${n.toString(16).padStart(6, "0")}`,
    kind: "backup",
    pinned: false,
    createdAt: at,
    sizeBytes: 30 * 1024 * 1024,
    local: true,
    remote: { "google-drive": { status: "uploaded" } },
    ...over,
  };
}

function status(over: Partial<BackupStatus["schedule"]> = {}): BackupStatus {
  return {
    schedule: {
      enabled: true,
      running: false,
      intervalHours: 12,
      lastRunAt: NOW - 2 * 3_600_000,
      lastSnapshotId: "20260930T151400Z-000001",
      nextRunAt: NOW + 10 * 3_600_000,
      consecutiveFailures: 0,
      lastError: undefined,
      ...over,
    },
    local: { count: 7, sizeBytes: 202 * 1024 * 1024, pinned: 4 },
    targets: [
      { id: "google-drive", name: "Google Drive", ready: true, snapshots: 7 },
    ],
    snapshots: [],
    policy: { keepLocal: 12, keepRemote: 30, encrypted: true },
  };
}

type Ctx = Context & {
  reply: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
};

function makeCtx(from = ADMIN, match = ""): Ctx {
  return {
    chat: { id: from, type: "private" },
    from: { id: from, first_name: "T" },
    match,
    reply: vi.fn().mockResolvedValue({ message_id: 5 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    api: { editMessageText: vi.fn().mockResolvedValue(true) },
  } as unknown as Ctx;
}

type Keyboard = { text: string; callback_data: string }[][];

function keyboardOf(call: unknown[] | undefined): Keyboard {
  const opts = call?.[1] as
    { reply_markup?: { inline_keyboard: Keyboard } } | undefined;
  return opts?.reply_markup?.inline_keyboard ?? [];
}

function lastEdit(ctx: Ctx): { text: string; keyboard: Keyboard } {
  const call = ctx.editMessageText.mock.calls.at(-1);
  return { text: String(call?.[0] ?? ""), keyboard: keyboardOf(call) };
}

function datas(keyboard: Keyboard): string[] {
  return keyboard.flat().map((b) => b.callback_data);
}

async function runCommand(ctx: Ctx): Promise<void> {
  let handler: ((ctx: Context) => Promise<void>) | undefined;
  const bot = {
    command: (_name: string, fn: (ctx: Context) => Promise<void>) => {
      handler = fn;
    },
  } as unknown as Bot;
  registerBackupCommand(bot);
  await handler!(ctx);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  _resetBackupPanelState();
  setAdminUserId(ADMIN);
  for (const fn of Object.values(backup)) fn.mockReset();
  respawnSelf.mockReset();
  backup.collectBackupStatus.mockResolvedValue(status());
  backup.listSnapshots.mockResolvedValue([]);
  backup.setSnapshotPinned.mockResolvedValue(true);
});

describe("status panel", () => {
  it("/backup replies with formatted HTML and the four panel buttons", async () => {
    const ctx = makeCtx();
    await runCommand(ctx);
    const [text, opts] = ctx.reply.mock.calls[0]!;
    expect(opts).toMatchObject({ parse_mode: "HTML" });
    expect(text).not.toContain("<pre>");
    expect(text).toContain("<b>Schedule:</b> every 12h · next in 10h 0m");
    expect(text).toContain("2026-10-01 03:14 UTC");
    expect(text).toContain("<b>Last snapshot:</b> 2h 0m ago");
    expect(text).toContain("7 snapshots · 202.0 MB · 📌 4 pinned");
    expect(text).toContain("🔒 on");
    expect(text).toContain("newest 12 kept here, 30 per target");
    expect(text).toContain("Google Drive <code>google-drive</code> — ✅ ready");
    const keyboard = keyboardOf(ctx.reply.mock.calls[0]);
    expect(keyboard.flat().map((b) => b.text)).toEqual([
      "📸 Back up now",
      "📋 Snapshots",
      "ℹ️ How restore works",
      "🔄 Refresh",
    ]);
  });

  it("shows a failing streak and escapes the error", async () => {
    backup.collectBackupStatus.mockResolvedValue(
      status({ consecutiveFailures: 2, lastError: "disk <full>" }),
    );
    const ctx = makeCtx();
    await runCommand(ctx);
    expect(ctx.reply.mock.calls[0]![0]).toContain(
      "⚠️ <b>Failing:</b> 2 runs in a row — disk &lt;full&gt;",
    );
  });

  it("refresh swallows Telegram's 'message is not modified'", async () => {
    const ctx = makeCtx();
    ctx.editMessageText.mockRejectedValue(
      new Error("Bad Request: message is not modified"),
    );
    await expect(
      handleBackupCallback(ctx, "backup:panel"),
    ).resolves.toBeUndefined();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("keeps the text subcommands", async () => {
    backup.listSnapshots.mockResolvedValue([snapshot(0)]);
    const ctx = makeCtx(ADMIN, "list");
    await runCommand(ctx);
    expect(ctx.reply.mock.calls[0]![0]).toContain("<pre>");
  });
});

describe("back up now", () => {
  it("edits the panel with progress, runs the backup, then shows the result", async () => {
    backup.runBackup.mockResolvedValue({
      id: "20260930T171400Z-abcdef",
      parts: [{}, {}, {}],
      sizeBytes: 34 * 1024 * 1024,
    });
    const ctx = makeCtx();
    await handleBackupCallback(ctx, "backup:now");
    expect(backup.runBackup).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "backup", trigger: "command" }),
    );
    const edits = ctx.editMessageText.mock.calls.map((c) => String(c[0]));
    expect(edits[0]).toContain("Taking a snapshot");
    const { text, keyboard } = lastEdit(ctx);
    expect(text).toContain(
      "✅ <code>20260930T171400Z-abcdef</code> — 3 part(s), 34.0 MB",
    );
    expect(text).toContain("<b>Backups</b>");
    expect(datas(keyboard)).toContain("backup:now");
  });

  it("reports a failure in place", async () => {
    backup.runBackup.mockRejectedValue(new Error("no space"));
    const ctx = makeCtx();
    await handleBackupCallback(ctx, "backup:now");
    expect(lastEdit(ctx).text).toContain("⚠️ Backup failed: no space");
  });

  it("refuses a second tap while one is running", async () => {
    let finish: (v: unknown) => void = () => {};
    backup.runBackup.mockReturnValue(new Promise((r) => (finish = r)));
    const first = handleBackupCallback(makeCtx(), "backup:now");
    const second = makeCtx();
    await handleBackupCallback(second, "backup:now");
    expect(second.answerCallbackQuery).toHaveBeenCalledWith({
      text: "A snapshot is already running.",
    });
    expect(backup.runBackup).toHaveBeenCalledTimes(1);
    finish({ id: "20260930T171400Z-abcdef", parts: [], sizeBytes: 0 });
    await first;
  });
});

describe("snapshots view", () => {
  const many = Array.from({ length: 12 }, (_, n) =>
    snapshot(n, n === 0 ? { pinned: true } : {}),
  );

  it("pages the list, newest first, with pin and restore per snapshot", async () => {
    backup.listSnapshots.mockResolvedValue(many);
    const ctx = makeCtx();
    await handleBackupCallback(ctx, "backup:list:0");
    const { text, keyboard } = lastEdit(ctx);
    expect(text).toContain("12 snapshots · page 1/3");
    expect(text).toContain(many[0]!.id);
    expect(text).not.toContain(many[SNAPSHOT_PAGE_SIZE]!.id);
    const data = datas(keyboard);
    expect(data).toContain(`backup:unpin:0:${many[0]!.id}`);
    expect(data).toContain(`backup:pin:0:${many[1]!.id}`);
    expect(data).toContain(`backup:ask:0:${many[1]!.id}`);
    expect(data).toContain("backup:list:1");
    expect(data).not.toContain("backup:list:-1");
    expect(data.at(-1)).toBe("backup:panel");
    for (const d of data) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);

    await handleBackupCallback(ctx, "backup:list:2");
    const last = lastEdit(ctx);
    expect(last.text).toContain("page 3/3");
    expect(last.text).toContain(many[11]!.id);
    expect(datas(last.keyboard)).toContain("backup:list:1");
    expect(datas(last.keyboard)).not.toContain("backup:list:3");
  });

  it("offers no restore for a remote-only snapshot", async () => {
    const remoteOnly = snapshot(0, { local: false });
    backup.listSnapshots.mockResolvedValue([remoteOnly]);
    const ctx = makeCtx();
    await handleBackupCallback(ctx, "backup:list:0");
    expect(lastEdit(ctx).text).toContain("remote only");
    expect(datas(lastEdit(ctx).keyboard)).not.toContain(
      `backup:ask:0:${remoteOnly.id}`,
    );
  });

  it("pin re-renders the same page", async () => {
    backup.listSnapshots.mockResolvedValue(many);
    const ctx = makeCtx();
    await handleBackupCallback(ctx, `backup:pin:1:${many[6]!.id}`);
    expect(backup.setSnapshotPinned).toHaveBeenCalledWith(many[6]!.id, true);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "📌 Pinned" });
    expect(lastEdit(ctx).text).toContain("page 2/3");
  });
});

describe("restore from the panel", () => {
  it("the Restore button opens the confirmation and restores nothing", async () => {
    const target = snapshot(3, { label: "before <rewrite>" });
    backup.readManifest.mockResolvedValue({ ...target, parts: [] });
    const ctx = makeCtx();
    await handleBackupCallback(ctx, `backup:ask:0:${target.id}`);
    expect(backup.writeRestorePending).not.toHaveBeenCalled();
    expect(respawnSelf).not.toHaveBeenCalled();
    const { text, keyboard } = lastEdit(ctx);
    expect(text).toContain(`Restore <code>${target.id}</code>?`);
    expect(text).toContain("before &lt;rewrite&gt;");
    expect(datas(keyboard)).toEqual([
      `backup:restore:${target.id}`,
      "backup:list:0",
    ]);
  });

  it("only the confirmation's button stages the restore", async () => {
    const target = snapshot(3);
    const ctx = makeCtx();
    await handleBackupCallback(ctx, `backup:restore:${target.id}`);
    expect(backup.writeRestorePending).toHaveBeenCalledWith(
      expect.objectContaining({
        id: target.id,
        requestedBy: String(ADMIN),
        frontend: "telegram",
      }),
    );
    expect(respawnSelf).toHaveBeenCalledTimes(1);
  });

  it("says so when the snapshot has no local copy", async () => {
    backup.readManifest.mockResolvedValue(null);
    const ctx = makeCtx();
    await handleBackupCallback(ctx, `backup:ask:0:${snapshot(1).id}`);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "That snapshot has no copy on this machine.",
    });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });
});

describe("access", () => {
  it.each([
    "backup:now",
    "backup:panel",
    "backup:list:0",
    `backup:pin:0:${snapshot(0).id}`,
    `backup:restore:${snapshot(0).id}`,
  ])("refuses %s from a non-admin", async (data) => {
    const ctx = makeCtx(OTHER);
    await handleBackupCallback(ctx, data);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Not authorized.",
    });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(backup.runBackup).not.toHaveBeenCalled();
    expect(backup.setSnapshotPinned).not.toHaveBeenCalled();
    expect(backup.writeRestorePending).not.toHaveBeenCalled();
    expect(respawnSelf).not.toHaveBeenCalled();
  });

  it("refuses the /backup command from a non-admin", async () => {
    const ctx = makeCtx(OTHER);
    await runCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith("Not authorized.");
    expect(backup.collectBackupStatus).not.toHaveBeenCalled();
  });
});

describe("callback grammar", () => {
  it("rejects malformed data", () => {
    for (const bad of [
      "backup:list:x",
      "backup:list:-1",
      "backup:pin:0:not-an-id",
      "backup:restore:../../etc",
      "backup:now:extra",
      "backup:nope",
    ]) {
      expect(parseBackupAction(bad)).toBeNull();
    }
    expect(parseBackupAction("backup:list:2")).toEqual({
      kind: "list",
      page: 2,
    });
  });
});
