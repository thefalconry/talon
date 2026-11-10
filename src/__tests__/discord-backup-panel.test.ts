/**
 * The Discord /backup panel buttons: the same grammar as Telegram, five
 * action rows at most, the restore button opening the confirmation only,
 * and the admin re-check on every press. The backup subsystem is mocked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SnapshotSummary } from "../core/backup/index.js";
import type { ComponentInteraction } from "../frontend/discord/callbacks/components/types.js";

const backup = {
  collectBackupStatus: vi.fn(),
  listSnapshots: vi.fn<() => Promise<SnapshotSummary[]>>(),
  readManifest: vi.fn(),
  runBackup: vi.fn(),
  setSnapshotPinned: vi.fn(),
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
let admin = true;
vi.mock("../frontend/discord/handlers/index.js", async (orig) => ({
  ...(await orig<object>()),
  isAdmin: () => admin,
}));

const { handleBackupComponent } =
  await import("../frontend/discord/commands/backup.js");
const { _resetDiscordBackupPanel } =
  await import("../frontend/discord/commands/backup-panel.js");

const NOW = Date.parse("2026-09-30T17:14:00Z");

function snapshot(n: number): SnapshotSummary {
  return {
    id: `20260930T${String(10 + n).padStart(2, "0")}0000Z-00000${n.toString(16)}`,
    kind: "backup",
    pinned: false,
    createdAt: NOW - (n + 1) * 3_600_000,
    sizeBytes: 1024,
    local: true,
    remote: {},
  };
}

type Payload = {
  content?: string;
  components?: { components: { custom_id: string }[] }[];
};

function press(customId: string) {
  const interaction = {
    customId,
    user: { id: "42" },
    guildId: null,
    channelId: "c",
    replied: false,
    deferred: false,
    update: vi.fn<(p: Payload) => Promise<void>>().mockResolvedValue(),
    editReply: vi.fn<(p: Payload) => Promise<void>>().mockResolvedValue(),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction;
}

function ids(p: Payload | undefined): string[] {
  return (p?.components ?? []).flatMap((row) =>
    row.components.map((c) => c.custom_id),
  );
}

beforeEach(() => {
  admin = true;
  _resetDiscordBackupPanel();
  for (const fn of Object.values(backup)) fn.mockReset();
  respawnSelf.mockReset();
  backup.listSnapshots.mockResolvedValue(
    Array.from({ length: 8 }, (_, n) => snapshot(n)),
  );
});

describe("discord backup panel", () => {
  it("pages snapshots in at most five action rows", async () => {
    const i = press("backup:list:0");
    expect(
      await handleBackupComponent(i as unknown as ComponentInteraction),
    ).toBe(true);
    const payload = i.update.mock.calls[0]![0];
    expect(payload.components!.length).toBeLessThanOrEqual(5);
    expect(payload.content).toContain("page 1/3");
    expect(ids(payload)).toContain(`backup:ask:0:${snapshot(0).id}`);
    expect(ids(payload)).toContain("backup:list:1");
  });

  it("Restore opens the confirmation and stages nothing", async () => {
    backup.readManifest.mockResolvedValue({ ...snapshot(2), parts: [] });
    const i = press(`backup:ask:0:${snapshot(2).id}`);
    await handleBackupComponent(i as unknown as ComponentInteraction);
    expect(backup.writeRestorePending).not.toHaveBeenCalled();
    expect(respawnSelf).not.toHaveBeenCalled();
    expect(ids(i.update.mock.calls[0]![0])).toEqual([
      `backup:restore:${snapshot(2).id}`,
      "backup:list:0",
    ]);
  });

  it("Back up now runs the backup and edits the reply with the result", async () => {
    backup.runBackup.mockResolvedValue({
      id: "20260930T171400Z-abcdef",
      parts: [{}],
      sizeBytes: 1024 * 1024,
    });
    backup.collectBackupStatus.mockResolvedValue({
      schedule: {
        enabled: false,
        running: false,
        consecutiveFailures: 0,
      },
      local: { count: 1, sizeBytes: 1, pinned: 0 },
      targets: [],
      snapshots: [],
    });
    const i = press("backup:now");
    await handleBackupComponent(i as unknown as ComponentInteraction);
    expect(i.update.mock.calls[0]![0].content).toContain("Taking a snapshot");
    const final = i.editReply.mock.calls[0]![0];
    expect(final.content).toContain("✅ `20260930T171400Z-abcdef`");
    expect(ids(final)).toContain("backup:now");
  });

  it("refuses a non-admin press", async () => {
    admin = false;
    const i = press("backup:now");
    await handleBackupComponent(i as unknown as ComponentInteraction);
    expect(i.update).toHaveBeenCalledWith({
      content: "Not authorized.",
      components: [],
    });
    expect(backup.runBackup).not.toHaveBeenCalled();
  });
});
