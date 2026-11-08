/**
 * Staleness guard for process-ending commands.
 *
 * Second layer under `update-offset.ts`. Confirming the offset stops the
 * redelivery that caused the restart loop, but it can't be guaranteed —
 * the confirmation is a network call on the way out, and a SIGKILL, a
 * crash, or a 409 from two pollers skips it entirely. Any command that
 * ends the process is therefore also checked for age: it must be newer
 * than this process, because a `/restart` issued before we booted has
 * either already been served (redelivery) or refers to a daemon that is
 * no longer running.
 *
 * Only self-terminating commands are gated. Ordinary messages sent while
 * the daemon was down are real work and must still be processed.
 */

import { logWarn } from "../../../util/log.js";

/**
 * Grace window for clock skew between Telegram's timestamps and ours,
 * and for a command issued in the seconds around a boot.
 */
const CLOCK_SKEW_GRACE_MS = 30_000;

/** When this process started — the cutoff a fresh command must beat. */
const PROCESS_START_MS = Date.now();

/**
 * True when a command predates this process and must not be re-executed.
 * `messageDate` is Telegram's `message.date` (seconds since epoch).
 */
export function isStaleCommand(
  messageDate: number | undefined,
  command: string,
): boolean {
  if (!messageDate) return false; // no timestamp — treat as live
  const sentAtMs = messageDate * 1000;
  if (sentAtMs >= PROCESS_START_MS - CLOCK_SKEW_GRACE_MS) return false;
  const ageSec = Math.round((Date.now() - sentAtMs) / 1000);
  logWarn(
    "bot",
    `Ignoring stale ${command} from ${ageSec}s ago — it predates this process ` +
      `(a redelivered restart would loop the daemon).`,
  );
  return true;
}
