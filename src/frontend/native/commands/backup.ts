/**
 * /backup — snapshots and checkpoints (operator only), the native half.
 *
 *   /backup                      status: schedule, sizes, targets
 *   /backup now                  take a snapshot now
 *   /backup checkpoint <label>   labelled, pinned snapshot
 *   /backup list                 recent snapshots
 *   /backup show <id>            one snapshot's manifest summary
 *   /backup pin|unpin <id>       keep past retention, or release
 *   /backup restore <id>         describe it and ask to confirm
 *   /backup restore <id> confirm staged restore + restart
 *
 * Same surface as Telegram's and Discord's /backup, with the confirmation
 * button replaced by a typed `confirm` — the bridge has no callback route
 * for button data. Restore does not happen in place either: the request
 * is staged to ~/.talon/restore-pending.json and applied by the next boot
 * before anything opens the database (core/backup/restore.ts, and
 * `applyStagedRestore` in app.ts), exactly as the other frontends do it.
 */

import {
  collectBackupStatus,
  formatBackupStatus,
  formatBytes,
  formatSnapshotList,
  isSnapshotId,
  listSnapshots,
  readManifest,
  runBackup,
  setSnapshotPinned,
  writeRestorePending,
} from "../../../core/backup/index.js";
import { respawnSelf } from "../../../core/daemon/respawn.js";
import { logError } from "../../../util/log.js";
import { fence } from "./format.js";
import type { NativeCommandContext } from "./types.js";

const USAGE = [
  "**/backup** — snapshots and checkpoints",
  "",
  "`/backup` — status",
  "`/backup now` — take a snapshot",
  "`/backup checkpoint <label>` — labelled, pinned checkpoint",
  "`/backup list` — recent snapshots",
  "`/backup show <id>` — one snapshot",
  "`/backup pin <id>` · `/backup unpin <id>`",
  "`/backup restore <id>` — restore (asks to confirm, then restarts)",
].join("\n");

const NOT_AN_ID = "That is not a snapshot id — `/backup list` shows them.";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function takeSnapshot(
  ctx: NativeCommandContext,
  label?: string,
): Promise<void> {
  ctx.reply(
    label ? `📸 Taking checkpoint “${label}”…` : "📸 Taking a snapshot…",
  );
  try {
    const manifest = await runBackup({
      kind: label ? "checkpoint" : "backup",
      label,
      pinned: Boolean(label),
      trigger: "command",
    });
    ctx.reply(
      `✅ \`${manifest.id}\` — ${manifest.parts.length} part(s), ` +
        `${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB` +
        (label ? " (pinned)" : ""),
    );
  } catch (err) {
    logError("backup", "/backup now failed", err);
    ctx.reply(`⚠️ Backup failed: ${errorText(err)}`);
  }
}

async function show(ctx: NativeCommandContext, id: string): Promise<void> {
  if (!isSnapshotId(id)) return ctx.reply(NOT_AN_ID);
  const manifest = await readManifest(id);
  if (!manifest) return ctx.reply(`No snapshot \`${id}\` on this machine.`);
  const remotes = Object.entries(manifest.remote ?? {});
  ctx.reply(
    [
      `**Snapshot \`${manifest.id}\`**${manifest.pinned ? " 📌" : ""}`,
      ...(manifest.label ? [`“${manifest.label}”`] : []),
      `Kind: ${manifest.kind} · taken ${new Date(manifest.createdAt).toISOString()}`,
      `Host: ${manifest.host} · Talon ${manifest.talonVersion}`,
      `Size: ${formatBytes(manifest.sizeBytes)} in ${manifest.parts.length} part(s)`,
      `Covers: ${manifest.includes.join(", ") || "—"}`,
      ...(remotes.length
        ? [
            `Remotes: ${remotes.map(([name, r]) => `${name} (${r.status})`).join(", ")}`,
          ]
        : []),
      "",
      `\`/backup restore ${manifest.id}\` restores it.`,
    ].join("\n"),
  );
}

async function setPinned(
  ctx: NativeCommandContext,
  id: string,
  pinned: boolean,
): Promise<void> {
  if (!isSnapshotId(id)) return ctx.reply(NOT_AN_ID);
  const ok = await setSnapshotPinned(id, pinned);
  ctx.reply(
    ok
      ? `${pinned ? "📌 Pinned" : "Unpinned"} \`${id}\``
      : `No snapshot \`${id}\``,
  );
}

/**
 * `/backup restore <id>` describes the snapshot and asks for the typed
 * confirmation; `/backup restore <id> confirm` stages it and hands off to
 * the successor, which applies it during boot.
 */
async function restore(
  ctx: NativeCommandContext,
  id: string,
  confirmed: boolean,
): Promise<void> {
  if (!isSnapshotId(id)) return ctx.reply(NOT_AN_ID);
  const manifest = await readManifest(id);
  if (!manifest) return ctx.reply(`No snapshot \`${id}\` on this machine.`);
  if (!confirmed) {
    ctx.reply(
      `♻️ **Restore \`${id}\`?**\n` +
        (manifest.label ? `“${manifest.label}”\n` : "") +
        `Taken ${new Date(manifest.createdAt).toISOString()}\n\n` +
        "This replaces config, prompts, keys, sessions, the database and memory, " +
        "then restarts. A pinned checkpoint of the current state is taken first.\n\n" +
        `Send \`/backup restore ${id} confirm\` to go ahead.`,
    );
    return;
  }
  try {
    await writeRestorePending({
      id,
      requestedAt: Date.now(),
      requestedBy: ctx.entry.id,
      frontend: "native",
    });
  } catch (err) {
    logError("backup", "Staging the restore failed", err);
    ctx.reply(`⚠️ Could not stage the restore: ${errorText(err)}`);
    return;
  }
  ctx.reply(
    `♻️ Restoring \`${id}\` — restarting now. The restore is applied during ` +
      "boot; the result is reported once Talon is back up.",
  );
  respawnSelf(`native /backup restore ${id}`);
}

/** `/backup <subcommand> [arg]`. */
export async function backupCommand(ctx: NativeCommandContext): Promise<void> {
  const [subcommand, ...rest] = ctx.arg.split(/\s+/).filter(Boolean);
  const target = rest[0] ?? "";
  switch (subcommand?.toLowerCase()) {
    case undefined:
    case "status":
      return ctx.reply(fence(formatBackupStatus(await collectBackupStatus())));
    case "now":
      return takeSnapshot(ctx);
    case "checkpoint": {
      const label = rest.join(" ").trim();
      if (!label)
        return ctx.reply(
          "Give the checkpoint a label: `/backup checkpoint before the rewrite`",
        );
      return takeSnapshot(ctx, label);
    }
    case "list":
      return ctx.reply(fence(formatSnapshotList(await listSnapshots())));
    case "show":
      return show(ctx, target);
    case "pin":
    case "unpin":
      return setPinned(ctx, target, subcommand.toLowerCase() === "pin");
    case "restore":
      return restore(ctx, target, rest[1]?.toLowerCase() === "confirm");
    default:
      return ctx.reply(USAGE);
  }
}
