/**
 * The /backup panel — status, snapshot pages and the restore guide —
 * written once and spelled per platform through a `ReportFormatter`.
 *
 * Each view is text plus a platform-neutral button grid (`PanelButton`:
 * a label and the callback data it sends back). Telegram maps the grid
 * onto an inline keyboard, Discord onto button rows; the callback data
 * grammar is shared, so both frontends parse taps with the same
 * `parseBackupAction`.
 *
 *   backup:panel               the status panel (also Refresh)
 *   backup:now                 take a snapshot, editing the panel in place
 *   backup:list:<page>         one page of snapshots
 *   backup:guide               how restore works
 *   backup:pin:<page>:<id>     pin, then re-render that page
 *   backup:unpin:<page>:<id>   unpin, then re-render that page
 *   backup:ask:<page>:<id>     the restore confirmation — nothing happens yet
 *   backup:restore:<id>        the confirmed restore: stage + restart
 *   backup:cancel              the confirmation's Cancel
 *
 * The longest of these (`backup:unpin:99:<23-char id>`) is 39 bytes,
 * inside Telegram's 64-byte callback_data cap and Discord's 100-char
 * custom_id cap.
 *
 * Restore stays the only destructive action and it is always two taps:
 * a snapshot's Restore button only opens the confirmation (`ask`); the
 * staged restore is `backup:restore:<id>`, which only the confirmation
 * offers.
 */

import {
  isSnapshotId,
  type BackupStatus,
  type SnapshotSummary,
} from "../../core/backup/index.js";
import { formatBytes } from "./format.js";
import type { ReportFormatter } from "./reports.js";

export type PanelButton = { label: string; data: string };
export type PanelView = { text: string; buttons: PanelButton[][] };
/** The manifest fields a restore confirmation names. */
type RestoreSubject = { id: string; label?: string; createdAt: number };

/**
 * Snapshots per page — one button row each, plus navigation and Back.
 * Telegram takes five; Discord allows five action rows in all, so it
 * pages by three.
 */
export const SNAPSHOT_PAGE_SIZE = 5;

export type BackupAction =
  | { kind: "panel" }
  | { kind: "now" }
  | { kind: "guide" }
  | { kind: "cancel" }
  | { kind: "list"; page: number }
  | { kind: "pin" | "unpin" | "ask"; page: number; id: string }
  | { kind: "restore"; id: string };

function pageOf(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,3}$/.test(raw)) return null;
  return Number(raw);
}

/** Parse `backup:*` callback data; null for anything malformed. */
export function parseBackupAction(data: string): BackupAction | null {
  const [prefix, action, a, b, ...extra] = data.split(":");
  if (prefix !== "backup" || extra.length > 0) return null;
  switch (action) {
    case "panel":
    case "now":
    case "guide":
    case "cancel":
      return a === undefined ? { kind: action } : null;
    case "list": {
      const page = pageOf(a);
      return page === null || b !== undefined ? null : { kind: "list", page };
    }
    case "pin":
    case "unpin":
    case "ask": {
      const page = pageOf(a);
      if (page === null || !b || !isSnapshotId(b)) return null;
      return { kind: action, page, id: b };
    }
    case "restore":
      return a && isSnapshotId(a) && b === undefined
        ? { kind: "restore", id: a }
        : null;
    default:
      return null;
  }
}

// ── Time ────────────────────────────────────────────────────────────────────

/** `2026-09-30 14:47 UTC` — the absolute half of every timestamp. */
function formatUtc(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `in 9h 34m`, `2h 27m ago`, `3d 4h ago`, `just now`. */
function formatAgo(at: number, now: number = Date.now()): string {
  const delta = at - now;
  const minutes = Math.round(Math.abs(delta) / 60_000);
  if (minutes === 0) return "just now";
  const hours = Math.floor(minutes / 60);
  const text =
    hours >= 48
      ? `${Math.floor(hours / 24)}d ${hours % 24}h`
      : hours > 0
        ? `${hours}h ${minutes % 60}m`
        : `${minutes}m`;
  return delta > 0 ? `in ${text}` : `${text} ago`;
}

function when(f: ReportFormatter, at: number, now: number): string {
  return `${formatAgo(at, now)} ${f.italic(`(${formatUtc(at)})`)}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ── Status panel ────────────────────────────────────────────────────────────

export const PANEL_BUTTONS: PanelButton[][] = [
  [
    { label: "📸 Back up now", data: "backup:now" },
    { label: "📋 Snapshots", data: "backup:list:0" },
  ],
  [
    { label: "ℹ️ How restore works", data: "backup:guide" },
    { label: "🔄 Refresh", data: "backup:panel" },
  ],
];

function scheduleLines(
  f: ReportFormatter,
  status: BackupStatus,
  now: number,
): string[] {
  const { schedule, local } = status;
  const lines: string[] = [];
  if (!schedule.enabled) {
    lines.push(`${f.bold("Schedule:")} off — manual snapshots only`);
  } else {
    lines.push(
      `${f.bold("Schedule:")} every ${schedule.intervalHours}h` +
        (schedule.nextRunAt
          ? ` · next ${when(f, schedule.nextRunAt, now)}`
          : ""),
    );
  }
  const lastAt = schedule.lastRunAt ?? local.newest?.createdAt;
  const lastId = schedule.lastSnapshotId ?? local.newest?.id;
  lines.push(
    lastAt
      ? `${f.bold("Last snapshot:")} ${when(f, lastAt, now)}` +
          (lastId ? ` · ${f.code(f.escape(lastId))}` : "")
      : `${f.bold("Last snapshot:")} none yet`,
  );
  if (schedule.running) lines.push("⏳ A snapshot is running right now.");
  if (schedule.consecutiveFailures > 0) {
    lines.push(
      `⚠️ ${f.bold("Failing:")} ${plural(schedule.consecutiveFailures, "run")} in a row — ` +
        f.escape(schedule.lastError ?? "unknown error"),
    );
  }
  return lines;
}

function storageLines(f: ReportFormatter, status: BackupStatus): string[] {
  const { local, policy } = status;
  const lines = [
    `${f.bold("On this machine:")} ${plural(local.count, "snapshot")} · ` +
      formatBytes(local.sizeBytes) +
      (local.pinned > 0 ? ` · 📌 ${local.pinned} pinned` : ""),
  ];
  if (policy) {
    lines.push(
      `${f.bold("Retention:")} newest ${policy.keepLocal} kept here, ` +
        `${policy.keepRemote} per target` +
        (policy.keepDaily ? ` · 1/day for ${policy.keepDaily}d` : "") +
        (policy.keepWeekly ? ` · 1/week for ${policy.keepWeekly}w` : "") +
        (policy.keepCheckpoints
          ? ` · ${policy.keepCheckpoints} checkpoints`
          : "") +
        ` · pinned ones and the last verified are never pruned`,
    );
    lines.push(
      policy.encrypted
        ? `${f.bold("Encryption:")} 🔒 on`
        : `${f.bold("Encryption:")} 🔓 off — snapshots stay on this machine`,
    );
  }
  return lines;
}

function targetLines(f: ReportFormatter, status: BackupStatus): string[] {
  if (status.targets.length === 0) {
    return [`${f.bold("Targets:")} none — local only`];
  }
  const lines = [f.bold("Targets:")];
  for (const target of status.targets) {
    const name = `${f.escape(target.name)} ${f.code(f.escape(target.id))}`;
    const state = !target.ready
      ? `⏸ not ready${target.detail ? ` — ${f.escape(target.detail)}` : ""}`
      : target.error
        ? `❌ unreachable — ${f.escape(target.error)}`
        : `✅ ready · ${plural(target.snapshots ?? 0, "snapshot")}`;
    lines.push(`• ${name} — ${state}`);
  }
  return lines;
}

/** The status panel body (no buttons). */
function renderBackupStatus(
  f: ReportFormatter,
  status: BackupStatus,
  now: number = Date.now(),
): string {
  return [
    `🗄 ${f.bold("Backups")}`,
    "",
    ...scheduleLines(f, status, now),
    "",
    ...storageLines(f, status),
    "",
    ...targetLines(f, status),
  ].join("\n");
}

export function backupPanelView(
  f: ReportFormatter,
  status: BackupStatus,
  now: number = Date.now(),
  notice?: string,
): PanelView {
  const body = renderBackupStatus(f, status, now);
  return {
    text: notice ? `${notice}\n\n${body}` : body,
    buttons: PANEL_BUTTONS,
  };
}

// ── Snapshot pages ──────────────────────────────────────────────────────────

const REMOTE_ICON: Record<string, string> = {
  uploaded: "✅",
  pending: "⏳",
  failed: "❌",
};

function snapshotBlock(
  f: ReportFormatter,
  snapshot: SnapshotSummary,
  n: number,
  now: number,
): string {
  const facts = [
    snapshot.kind,
    formatBytes(snapshot.sizeBytes),
    ...(snapshot.pinned ? ["📌 pinned"] : []),
    ...(snapshot.local ? [] : ["remote only"]),
  ];
  const lines = [
    `${f.bold(`${n}.`)} ${f.code(snapshot.id)} — ${when(f, snapshot.createdAt, now)}`,
    `   ${facts.join(" · ")}`,
  ];
  if (snapshot.label) lines.push(`   “${f.escape(snapshot.label)}”`);
  const remotes = Object.entries(snapshot.remote).map(
    ([id, entry]) => `${f.escape(id)} ${REMOTE_ICON[entry.status] ?? "?"}`,
  );
  if (remotes.length > 0) lines.push(`   ☁️ ${remotes.join(" · ")}`);
  return lines.join("\n");
}

function snapshotButtons(
  snapshot: SnapshotSummary,
  n: number,
  page: number,
): PanelButton[] {
  const row: PanelButton[] = [
    snapshot.pinned
      ? { label: `Unpin #${n}`, data: `backup:unpin:${page}:${snapshot.id}` }
      : { label: `📌 Pin #${n}`, data: `backup:pin:${page}:${snapshot.id}` },
  ];
  // Chat restores read the local copy; a remote-only one is a CLI job.
  if (snapshot.local) {
    row.push({
      label: `♻️ Restore #${n}`,
      data: `backup:ask:${page}:${snapshot.id}`,
    });
  }
  return row;
}

function navRow(page: number, pages: number): PanelButton[] {
  const row: PanelButton[] = [];
  if (page > 0) row.push({ label: "‹ Newer", data: `backup:list:${page - 1}` });
  if (page < pages - 1) {
    row.push({ label: "Older ›", data: `backup:list:${page + 1}` });
  }
  return row;
}

/** One page of snapshots, newest first. Out-of-range pages clamp. */
export function snapshotPageView(
  f: ReportFormatter,
  snapshots: readonly SnapshotSummary[],
  requestedPage: number,
  now: number = Date.now(),
  pageSize: number = SNAPSHOT_PAGE_SIZE,
): PanelView & { page: number; pages: number } {
  const back: PanelButton[] = [{ label: "⬅️ Back", data: "backup:panel" }];
  if (snapshots.length === 0) {
    return {
      text: `📋 ${f.bold("Snapshots")}\n\nNo snapshots yet — tap Back, then 📸 Back up now.`,
      buttons: [back],
      page: 0,
      pages: 1,
    };
  }
  const pages = Math.ceil(snapshots.length / pageSize);
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const start = page * pageSize;
  const items = snapshots.slice(start, start + pageSize);
  const header =
    `📋 ${f.bold("Snapshots")} · ${plural(snapshots.length, "snapshot")}` +
    (pages > 1 ? ` · page ${page + 1}/${pages}` : "");
  const blocks = items.map((snapshot, i) =>
    snapshotBlock(f, snapshot, start + i + 1, now),
  );
  const buttons = items.map((snapshot, i) =>
    snapshotButtons(snapshot, start + i + 1, page),
  );
  const nav = navRow(page, pages);
  if (nav.length > 0) buttons.push(nav);
  buttons.push(back);
  return {
    text: [header, "", blocks.join("\n\n")].join("\n"),
    buttons,
    page,
    pages,
  };
}

// ── Restore ─────────────────────────────────────────────────────────────────

/** The confirmation prompt — shared by `/backup restore <id>` and the panel. */
export function renderRestoreConfirm(
  f: ReportFormatter,
  manifest: RestoreSubject,
): string {
  return (
    `♻️ ${f.bold(`Restore ${f.code(f.escape(manifest.id))}?`)}\n` +
    (manifest.label ? `“${f.escape(manifest.label)}”\n` : "") +
    `Taken ${new Date(manifest.createdAt).toISOString()}\n\n` +
    "This replaces config, prompts, keys, sessions, the database and memory, " +
    "then restarts. A pinned checkpoint of the current state is taken first."
  );
}

/** The panel's confirmation: Cancel goes back to the page it came from. */
export function restoreConfirmView(
  f: ReportFormatter,
  manifest: RestoreSubject,
  page: number,
): PanelView {
  return {
    text: renderRestoreConfirm(f, manifest),
    buttons: [
      [
        {
          label: "♻️ Restore and restart",
          data: `backup:restore:${manifest.id}`,
        },
        { label: "Cancel", data: `backup:list:${page}` },
      ],
    ],
  };
}

/**
 * How restore works. Every sentence here is something core/backup does —
 * plan.ts (what is captured), snapshot.ts (the parts), restore.ts (verify,
 * checkpoint, replace, the staged boot path) and the CLI's restore flags.
 */
export function renderRestoreGuide(f: ReportFormatter): string {
  const c = (s: string) => f.code(f.escape(s));
  return [
    `ℹ️ ${f.bold("How restore works")}`,
    "",
    f.bold("What a snapshot holds"),
    `• ${f.bold("State")} — config.json, prompts, keys, plugins, mesh devices, the database ` +
      `(a consistent ${c("VACUUM INTO")} copy) and the workspace files that make the agent ` +
      "(by default identity, memory, skills, scripts, secrets, stickers).",
    `• ${f.bold("Sessions")} — backend transcripts, session databases and traces ` +
      `(unless ${c("backup.includeSessions")} is off).`,
    `• ${f.bold("Palace")} — the memory palace in its own part; an unchanged palace is reused, not recompressed.`,
    `• ${f.bold("Logins")} — WhatsApp pairing and the userbot session. They stay on this machine ` +
      `unless ${c("backup.loginSessions")} is ${c("remote")}.`,
    "Left out: logs, virtualenvs, the ns/ mount, other snapshots and the rest of the workspace " +
      "(uploads, media, checkouts).",
    "",
    f.bold("What a restore does"),
    "• Verifies the snapshot first — every part's checksum, and its signature when encrypted — before touching anything.",
    `• Takes a pinned ${c("pre-restore <id>")} checkpoint of the current state. Restore that one to undo.`,
    "• Puts everything the snapshot covers back exactly as it was — memory, sessions, the database. " +
      "Whatever changed since the snapshot is replaced.",
    `• From chat it is staged (${c("restore-pending.json")}) and Talon restarts; the next boot applies it ` +
      "before the database opens and reports back. A staged request expires after 10 minutes, " +
      "and a failed restore is dropped so Talon still boots (the reason is in the log).",
    "• Chat restores need the snapshot's local copy.",
    "",
    f.bold("From a terminal"),
    `${c("talon stop")}, then ${c("talon backup restore <id>")} (it asks you to type yes).`,
    `${c("--from <target>")} fetches a snapshot this machine does not have; ` +
      `${c("--clone")} restores onto a new machine, relocating session and plugin paths.`,
    `Encrypted snapshots need their passphrase (${c("TALON_BACKUP_PASSPHRASE")} or ` +
      `${c("backup.encryption.passphraseFile")}) — keep a copy off this machine.`,
  ].join("\n");
}

export const GUIDE_BUTTONS: PanelButton[][] = [
  [
    { label: "📋 Snapshots", data: "backup:list:0" },
    { label: "⬅️ Back", data: "backup:panel" },
  ],
];
