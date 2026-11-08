/**
 * Telegram's spelling of the /backup panel: the shared views from
 * `frontend/presentation/backup-panel.ts`, rendered in HTML and mapped
 * onto inline keyboards. The command (`commands/backup.ts`) sends these;
 * the `backup:*` callbacks (`callbacks/backup.ts`) edit them in place.
 */

import {
  collectBackupStatus,
  listSnapshots,
} from "../../../core/backup/index.js";
import {
  GUIDE_BUTTONS,
  backupPanelView,
  renderRestoreGuide,
  snapshotPageView,
  type PanelButton,
  type PanelView,
} from "../../presentation/backup-panel.js";
import { TELEGRAM_REPORTS } from "./html.js";
import type { SettingsButton } from "./menu.js";

export function inlineKeyboard(
  rows: readonly PanelButton[][],
): SettingsButton[][] {
  return rows.map((row) =>
    row.map((button) => ({ text: button.label, callback_data: button.data })),
  );
}

/** The status panel, freshly collected. `notice` leads it (a result line). */
export async function loadStatusPanel(notice?: string): Promise<PanelView> {
  return backupPanelView(
    TELEGRAM_REPORTS,
    await collectBackupStatus(),
    Date.now(),
    notice,
  );
}

export async function loadSnapshotPage(page: number): Promise<PanelView> {
  return snapshotPageView(TELEGRAM_REPORTS, await listSnapshots(), page);
}

export function restoreGuideView(): PanelView {
  return { text: renderRestoreGuide(TELEGRAM_REPORTS), buttons: GUIDE_BUTTONS };
}
