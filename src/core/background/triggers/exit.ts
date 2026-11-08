/**
 * Trigger lifecycle endings — timeout, cancel, shutdown, child kill, the
 * authoritative `finalizeExit` settlement, and the `failTrigger` fail-to-spawn
 * path.
 */

import type { ChildProcess } from "node:child_process";
import {
  getTrigger,
  updateTrigger,
  SHUTDOWN_KILL_ERROR,
  type Trigger,
  type TriggerStatus,
} from "../../../storage/triggers.js";
import { log, logDebug, logError } from "../../../util/log.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import {
  children,
  timeouts,
  logStreams,
  lineBuffers,
  lifecycle,
  wardened,
  SIGTERM_GRACE_MS,
  WARDEN_GRACE_SLACK_MS,
} from "./state.js";
import { bufferAsPayload, fireWake } from "./output.js";
import { raiseAlert, resolveAlert } from "../../frontend-runtime/alerts.js";
import { faultText } from "../../engine/fault-text.js";

/** Exit codes that mean the command itself could not run. */
const CANNOT_RUN_CODES: Readonly<Record<number, string>> = {
  126: "command not executable",
  127: "command not found",
};

/**
 * Tell the operator about a trigger that broke rather than finished: its
 * command could not run (exit 126/127) or the process died on a signal
 * nobody sent it (a crash, the OOM killer — Talon's own kills set the
 * status before the exit lands, so they never reach `errored`). An
 * ordinary non-zero exit is the script's own verdict and already reaches
 * the chat as a wake. A clean fire clears an earlier alert for the id.
 */
function alertOnExit(
  t: Trigger,
  status: TriggerStatus,
  code: number | null,
  signal: NodeJS.Signals | null,
  output: string[],
): void {
  const key = `trigger.${t.id}`;
  if (status === "fired") {
    resolveAlert(key, `Trigger "${t.name}" is firing normally again.`);
    return;
  }
  if (status !== "errored") return;
  const cause =
    signal !== null
      ? `crashed (${signal})`
      : code !== null && CANNOT_RUN_CODES[code]
        ? `could not run its command (exit ${code}: ${CANNOT_RUN_CODES[code]})`
        : null;
  if (!cause) return;
  const last = output.at(-1);
  log(
    "triggers",
    `trigger.broken id=${t.id} name="${t.name}" code=${code} signal=${signal} cause="${cause}"`,
  );
  raiseAlert(
    key,
    `Trigger "${t.name}" [${t.id}] ${cause}${last ? `: ${faultText(last)}` : "."}`,
    { severity: "warn" },
  );
}

export function handleTimeout(trigger: Trigger): void {
  timeouts.delete(trigger.id);
  const c = children.get(trigger.id);
  if (!c) return;
  log(
    "triggers",
    `Timeout for "${trigger.name}" [${trigger.id}] after ${trigger.timeoutSeconds}s — killing`,
  );
  updateTrigger(trigger.id, {
    status: "timed_out",
    lastError: `Timed out after ${trigger.timeoutSeconds}s`,
  });
  killChild(trigger.id, c);
}

/** Cancel a running trigger. Idempotent. */
export function cancelTrigger(id: string): boolean {
  const child = children.get(id);
  if (!child) return false;
  updateTrigger(id, {
    status: "cancelled",
    lastError: "Cancelled by user",
  });
  killChild(id, child);
  return true;
}

/** Kill all running children — called during shutdown. */
export async function shutdownTriggers(): Promise<void> {
  // Flag first, unconditionally: a child that exits on its own from here on
  // must not dispatch a wake either — the backend pool is going away.
  lifecycle.shuttingDown = true;
  if (children.size === 0) return;
  log("triggers", `Shutting down ${children.size} running trigger(s)`);
  const ids = Array.from(children.keys());
  for (const id of ids) {
    const c = children.get(id);
    if (!c) continue;
    const t = getTrigger(id);
    if (t?.persistent) {
      // Park persistent triggers in "pending" so resumeAfterRestart() respawns
      // them on next startup. Keep the stored pid — finalizeExit clears it when
      // the child actually exits. If the child explicitly ignores SIGTERM and
      // outlives Talon, the pid survives to disk so the next boot's
      // resumeAfterRestart() can SIGKILL the orphan before respawning.
      updateTrigger(id, { status: "pending" });
    } else {
      updateTrigger(id, {
        status: "terminated",
        lastError: SHUTDOWN_KILL_ERROR,
      });
    }
    killChild(id, c);
  }
  // Give children a brief grace window to actually exit so logs flush
  await new Promise((r) => setTimeout(r, 250));
}

function killChild(id: string, child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  // Warden handles forward the TERM to the child's process group and run their
  // own grace escalation — give them headroom to finish it before the
  // last-resort SIGKILL here.
  const graceMs = wardened.has(id)
    ? SIGTERM_GRACE_MS + WARDEN_GRACE_SLACK_MS
    : SIGTERM_GRACE_MS;
  const grace = setTimeout(() => {
    if (children.has(id)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, graceMs);
  grace.unref();
}

export async function finalizeExit(
  id: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  children.delete(id);
  wardened.delete(id);
  const timer = timeouts.get(id);
  if (timer) {
    clearTimeout(timer);
    timeouts.delete(id);
  }

  const stream = logStreams.get(id);
  if (stream) {
    // Await the flush so any caller observing `status === "fired"` is
    // guaranteed to find the exit footer on disk.
    stream.write(`--- exit code=${code} signal=${signal} ---\n`);
    await new Promise<void>((resolve) => stream.end(resolve));
    logStreams.delete(id);
  }

  const buffered = lineBuffers.get(id) ?? [];
  lineBuffers.delete(id);

  const t = getTrigger(id);
  if (!t) return;

  // Status was already set by cancel/timeout/shutdown handlers — only set a
  // terminal status here if the child exited on its own.
  let status: TriggerStatus = t.status;
  let payload: string | undefined;

  // Persistent triggers parked as "pending" by shutdownTriggers must stay
  // "pending" so resumeAfterRestart respawns them on next boot. Skip the
  // status-rewrite and the endedAt stamp; just clear the PID and persist.
  if (t.persistent && t.status === "pending") {
    updateTrigger(id, { pid: undefined, pidStarttime: undefined });
    log(
      "triggers",
      `Exited (persistent) "${t.name}" [${id}] code=${code} signal=${signal} — will respawn on next start`,
    );
    return;
  }

  if (t.status === "running" || t.status === "pending") {
    if (code === 0) {
      status = "fired";
      payload = bufferAsPayload(buffered);
    } else {
      status = "errored";
      payload = bufferAsPayload(buffered, code ?? undefined);
    }
  } else {
    payload = bufferAsPayload(buffered);
  }

  updateTrigger(id, {
    status,
    endedAt: Date.now(),
    pid: undefined,
    pidStarttime: undefined,
    exitCode: code ?? undefined,
  });

  log(
    "triggers",
    `Exited "${t.name}" [${id}] code=${code} signal=${signal} → ${status}`,
  );
  alertOnExit(t, status, code, signal, buffered);

  appendDailyLog(
    "Triggers",
    `Trigger "${t.name}" ended with status=${status}${
      code != null ? ` code=${code}` : ""
    }`,
  );

  // Fire a wake-up for terminal statuses so the bot sees what happened
  if (
    status === "fired" ||
    status === "errored" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "terminated"
  ) {
    // During shutdown the backend pool is being torn down alongside us, so a
    // dispatch here can only fail ("Backend role not bound"). Skip it; the
    // record keeps status=terminated + SHUTDOWN_KILL_ERROR and no lastFireAt
    // bump, which is exactly what resumeAfterRestart's late death notice
    // keys on — the chat hears about it on the next boot instead.
    if (lifecycle.shuttingDown) {
      logDebug(
        "triggers",
        `Skipped ${status} wake for "${t.name}" [${id}] — shutting down; deferred to next boot`,
      );
      return;
    }
    await fireWake(id, status, payload, /* terminal */ true);
  }
}

export function failTrigger(t: Trigger, message: string): void {
  logError("triggers", `Failed to spawn ${t.id}: ${message}`);
  raiseAlert(
    `trigger.${t.id}`,
    `Trigger "${t.name}" [${t.id}] failed to start: ${faultText(message)}`,
    { severity: "warn" },
  );
  updateTrigger(t.id, {
    status: "errored",
    lastError: message,
    endedAt: Date.now(),
  });
}
