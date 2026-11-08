/**
 * Update-offset confirmation — the reason a `/restart` used to run twice.
 *
 * Telegram's getUpdates is at-least-once: an update stays queued until a
 * LATER call passes `offset = update_id + 1`. grammY advances that offset
 * on its next poll, so a command that ends the process — `/restart`,
 * `/update` — exits before the confirmation is ever sent. Telegram then
 * redelivers it to the successor, which restarts, which never confirms
 * either: a boot loop that survives every restart, observed live on
 * 2026-08-22 taking the daemon down four times in a row.
 *
 * The fix is to confirm explicitly before exiting. This module tracks the
 * highest update_id seen and `confirmUpdates` acknowledges it with a
 * zero-timeout getUpdates, which is exactly what grammY's next poll would
 * have done.
 */

import type { Bot } from "grammy";
import { log, logWarn } from "../../../util/log.js";

let highestUpdateId = 0;

/** Record an update as seen. Called for every update grammY dispatches. */
export function noteUpdateId(updateId: number): void {
  if (updateId > highestUpdateId) highestUpdateId = updateId;
}

/** Highest update id seen this process (0 when none). Test seam. */
export function lastUpdateId(): number {
  return highestUpdateId;
}

/** Test seam: forget the tracked offset. */
export function resetUpdateOffset(): void {
  highestUpdateId = 0;
}

/**
 * Tell Telegram every update seen so far is handled, so none of them is
 * redelivered to the next process. Best-effort: this runs on the
 * shutdown path, where a failure must never block exit.
 */
export async function confirmUpdates(bot: Bot): Promise<void> {
  if (highestUpdateId === 0) return;
  try {
    await bot.api.getUpdates({
      offset: highestUpdateId + 1,
      limit: 1,
      timeout: 0,
    });
    log("shutdown", `Confirmed Telegram updates through ${highestUpdateId}`);
  } catch (err) {
    logWarn(
      "shutdown",
      `Could not confirm Telegram update offset: ${err instanceof Error ? err.message : err}`,
    );
  }
}
