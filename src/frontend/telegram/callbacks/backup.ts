/**
 * `backup:*` callbacks — the /backup panel and the restore confirmation.
 *
 *   backup:panel              status panel (Refresh, Back)
 *   backup:now                take a snapshot, editing the panel in place
 *   backup:list:<page>        a page of snapshots
 *   backup:guide              how restore works
 *   backup:pin|unpin:<p>:<id> pin or release, then re-render the page
 *   backup:ask:<p>:<id>       open the restore confirmation (nothing happens yet)
 *   backup:restore:<id>       stage the restore and restart
 *   backup:cancel             do nothing, say so
 *
 * Every tap re-checks the admin: a button is only a message, and anyone
 * who can see it can press it. The confirmation is the whole safety
 * mechanism for restore — it replaces the database, the memory and the
 * identity of a running agent, so nothing stages without a second,
 * explicit admin tap on `backup:restore:<id>`, which only the
 * confirmation offers. The grammar lives in
 * frontend/presentation/backup-panel.ts.
 */

import type { Context } from "grammy";
import { readManifest, setSnapshotPinned } from "../../../core/backup/index.js";
import {
  PANEL_BUTTONS,
  parseBackupAction,
  restoreConfirmView,
  type PanelView,
} from "../../presentation/backup-panel.js";
import { runSnapshotForChat, stageRestore } from "../commands/backup.js";
import { isAuthorizedAdmin } from "../commands/state.js";
import {
  inlineKeyboard,
  loadSnapshotPage,
  loadStatusPanel,
  restoreGuideView,
} from "../render/backup-panel.js";
import { TELEGRAM_REPORTS } from "../render/html.js";
import { logError } from "../../../util/log.js";
import { answerCallbackQuerySafe, editOrIgnoreSame } from "./query.js";

/** One panel snapshot at a time: a double tap must not take two. */
let panelSnapshotRunning = false;

/** Tests only. */
export function _resetBackupPanelState(): void {
  panelSnapshotRunning = false;
}

function show(ctx: Context, view: PanelView): Promise<void> {
  return editOrIgnoreSame(ctx, view.text, inlineKeyboard(view.buttons));
}

async function backUpNow(ctx: Context): Promise<void> {
  if (panelSnapshotRunning) {
    await answerCallbackQuerySafe(ctx, {
      text: "A snapshot is already running.",
    });
    return;
  }
  panelSnapshotRunning = true;
  try {
    await answerCallbackQuerySafe(ctx, { text: "📸 Snapshot started" });
    await editOrIgnoreSame(
      ctx,
      "📸 <b>Taking a snapshot…</b>\n" +
        "Building it, then pruning and uploading to any targets. " +
        "This can take a few minutes — this message updates when it is done.",
      [],
    );
    const result = await runSnapshotForChat();
    // The snapshot's outcome must land even if the status read after it
    // does not: fall back to the bare result line under the panel buttons.
    const view = await loadStatusPanel(result.text).catch((err: unknown) => {
      logError("backup", "Backup panel status read failed", err);
      return { text: result.text, buttons: PANEL_BUTTONS };
    });
    await show(ctx, view);
  } finally {
    panelSnapshotRunning = false;
  }
}

async function togglePin(
  ctx: Context,
  id: string,
  page: number,
  pinned: boolean,
): Promise<void> {
  const ok = await setSnapshotPinned(id, pinned);
  await answerCallbackQuerySafe(ctx, {
    text: ok ? (pinned ? "📌 Pinned" : "Unpinned") : "No such snapshot",
  });
  await show(ctx, await loadSnapshotPage(page));
}

/** The panel's Restore button: the confirmation, never the restore. */
async function askToRestore(
  ctx: Context,
  id: string,
  page: number,
): Promise<void> {
  const manifest = await readManifest(id);
  if (!manifest) {
    await answerCallbackQuerySafe(ctx, {
      text: "That snapshot has no copy on this machine.",
    });
    return;
  }
  await answerCallbackQuerySafe(ctx);
  await show(ctx, restoreConfirmView(TELEGRAM_REPORTS, manifest, page));
}

async function confirmRestore(ctx: Context, id: string): Promise<void> {
  await answerCallbackQuerySafe(ctx, { text: "Restoring…" });
  await ctx
    .editMessageText(
      `♻️ Restoring <code>${id}</code> — restarting now. ` +
        "The restore is applied during boot; I will report back when I am up.",
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  try {
    await stageRestore(String(ctx.chat?.id ?? ctx.from?.id ?? ""), id);
  } catch (err) {
    logError("backup", "Staging the restore failed", err);
    await ctx
      .editMessageText(
        `⚠️ Could not stage the restore: ${err instanceof Error ? err.message : String(err)}`,
      )
      .catch(() => {});
  }
}

export async function handleBackupCallback(
  ctx: Context,
  data: string,
): Promise<void> {
  if (!isAuthorizedAdmin(ctx)) {
    await answerCallbackQuerySafe(ctx, { text: "Not authorized." });
    return;
  }
  const action = parseBackupAction(data);
  if (!action) {
    await answerCallbackQuerySafe(ctx, { text: "Invalid callback data" });
    return;
  }
  try {
    switch (action.kind) {
      case "cancel":
        await answerCallbackQuerySafe(ctx, { text: "Cancelled." });
        await ctx.editMessageText("Restore cancelled.").catch(() => {});
        return;
      case "restore":
        await confirmRestore(ctx, action.id);
        return;
      case "now":
        await backUpNow(ctx);
        return;
      case "pin":
      case "unpin":
        await togglePin(ctx, action.id, action.page, action.kind === "pin");
        return;
      case "ask":
        await askToRestore(ctx, action.id, action.page);
        return;
      case "panel":
        await answerCallbackQuerySafe(ctx);
        await show(ctx, await loadStatusPanel());
        return;
      case "list":
        await answerCallbackQuerySafe(ctx);
        await show(ctx, await loadSnapshotPage(action.page));
        return;
      case "guide":
        await answerCallbackQuerySafe(ctx);
        await show(ctx, restoreGuideView());
        return;
    }
  } catch (err) {
    logError("backup", `Backup panel action ${action.kind} failed`, err);
    await answerCallbackQuerySafe(ctx, {
      text: "⚠️ That did not work — see the log.",
    });
  }
}
