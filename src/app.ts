/**
 * Talon — agentic AI harness.
 * Composition root: loads config, creates frontend + backend, wires dispatcher.
 *
 * Frontends (Telegram, Terminal) and backends (Claude, OpenCode)
 * are loaded dynamically — only the selected platform's dependencies are required.
 */

import { ConfigFileError, getFrontends } from "./core/config/index.js";
import { startUploadCleanup, stopUploadCleanup } from "./core/vfs/workspace.js";
import { flushDatabase } from "./storage/db.js";
import { getActiveCount, stopAllTurns } from "./core/engine/dispatcher.js";
import {
  startPulseTimer,
  stopPulseTimer,
} from "./core/background/pulse/pulse.js";
import { stopPlanAlerts } from "./core/background/pulse/plan-alerts.js";
import {
  startHeartbeatTimer,
  stopHeartbeatTimer,
  awaitCurrentRun as awaitHeartbeat,
} from "./core/background/heartbeat/index.js";
import {
  startCronTimer,
  stopCronTimer,
  runStartupCatchup,
} from "./core/background/cron/scheduler.js";
import { shutdownTriggers } from "./core/background/triggers/index.js";
import { shutdownAgents } from "./core/agents/index.js";
import { stopBackupScheduler } from "./core/backup/index.js";
import { pruneSettledTriggers } from "./storage/triggers.js";
import { startWatchdog, stopWatchdog } from "./util/watchdog.js";
import {
  BOOT_SMOKE_FLAG,
  BOOT_SMOKE_OK,
  setRespawnShutdown,
  spawnSuccessor,
} from "./core/daemon/respawn.js";
import {
  crashCleanup,
  crashStep,
  handleUncaughtException,
  handleUnhandledRejection,
} from "./core/daemon/crash.js";
import { writeCrashMarker } from "./core/daemon/crash-marker.js";
import {
  announceLastCrash,
  startHealthAlerts,
  stopHealthAlerts,
} from "./core/daemon/health-alerts.js";
import { log, logError, logWarn } from "./util/log.js";
import { bootPhase, bootReport } from "./core/daemon/boot-timer.js";
import {
  getVfs,
  mountNamespaceFs,
  unmountNamespaceFs,
} from "./core/vfs/index.js";
import { bootstrap, initBackendAndDispatcher } from "./bootstrap.js";
import { Gateway } from "./core/engine/gateway.js";
import {
  createFrontendById,
  getFrontendDescriptor,
  startFrontends,
} from "./core/frontend-runtime/index.js";
import type { Frontend } from "./bootstrap.js";
// Attach every built-in frontend's create() to its registry descriptor.
// Adding a frontend is strictly additive: drop a factory.ts under the
// new frontend dir and list it in frontend/factories.ts.
import "./frontend/factories.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

import {
  writePidRecord,
  removePidRecordIfOwnedBy,
} from "./core/daemon/pidfile.js";
import { stampDaemonOwner } from "./core/daemon/pidfile.js";
import {
  recordBootMetrics,
  startResourceSampler,
  stopResourceSampler,
} from "./core/daemon/resource-sampler.js";

// `/update` runs the freshly installed tree with --boot-smoke before it
// hands off. Every static import above has just been resolved against
// the new node_modules — reaching this line is the proof that the tree
// the successor will run is importable at all. Nothing has booted yet,
// so this is both the strongest and the last harmless place to say so.
// See core/update/self-update.ts for what a failure does instead.
//
// This stays ahead of the staged restore below: the smoke run must not
// touch state, and a restore is the single most destructive thing this
// file does.
if (process.argv.includes(BOOT_SMOKE_FLAG)) {
  console.log(BOOT_SMOKE_OK);
  process.exit(0);
}

// One daemon per install. This runs before anything with a side effect
// (restore, database, pidfile, trigger resume), because a second daemon
// does damage in each of them — see checkSingleInstance in core/daemon/discovery.ts.
{
  const { checkSingleInstance, describeRefusal } =
    await import("./core/daemon/discovery.js");
  const verdict = await checkSingleInstance();
  if (!verdict.ok) {
    const message = describeRefusal(verdict.instance);
    logError("bot", message);
    console.error(`talon: ${message}`);
    process.exit(1);
  }
}
// Every child spawned from here on names this daemon as its owner, so an
// orphan sweep can tell a dead daemon's leftovers from a live one's runs.
stampDaemonOwner();

/**
 * A `/backup restore <id>` from chat writes ~/.talon/restore-pending.json
 * and restarts. It is applied HERE, before anything else: every store
 * below opens the database, and the database is one of the files this is
 * about to replace. The pre-restore checkpoint inside needs the current
 * database, so the handle is closed between the two — which is why the
 * composition root, and not core/backup, owns that call.
 *
 * Never throws: a failed restore still boots the daemon (with the reason
 * in the log and the request deleted, so the next boot is normal).
 */
async function applyStagedRestore(): Promise<string | null> {
  const { applyPendingRestore, readRestorePending } =
    await import("./core/backup/index.js");
  if (!(await readRestorePending())) return null;
  const { loadConfig } = await import("./core/config/index.js");
  const { resolveBackupSettings } = await import("./core/backup/plan.js");
  const { closeDatabase } = await import("./storage/db.js");
  const report = await applyPendingRestore({
    settings: resolveBackupSettings(loadConfig().backup),
    beforeApply: closeDatabase,
  });
  if (!report) return null;
  return (
    `♻️ Restored snapshot ${report.id}` +
    (report.checkpointId
      ? ` (previous state saved as checkpoint ${report.checkpointId})`
      : "")
  );
}

/**
 * A present-but-invalid config.json is fatal at startup: print the file
 * path and every problem, then exit non-zero. Booting on defaults instead
 * would put the daemon in a surprising state (wrong frontend, no plugins).
 */
async function withConfigGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConfigFileError) {
      logError("config", err.message);
      console.error(`talon: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const restoreReport = await withConfigGuard(() =>
  bootPhase("staged restore", applyStagedRestore),
);

/**
 * The first boot of a new version (a Docker/TrueNAS image pull, an npm or
 * binary upgrade — anything but `/update`, which checkpoints itself) takes
 * a pinned `pre-upgrade <old>→<new>` checkpoint HERE: after a staged
 * restore, before bootstrap opens the stores and the backend reconcile or
 * any migration runs against them. A failed checkpoint alerts the admin
 * and still boots, but with the destructive boot steps skipped.
 *
 * Never throws.
 */
async function checkpointIfUpgraded(): Promise<{ safe: boolean }> {
  try {
    const { checkpointOnVersionChange } =
      await import("./core/backup/index.js");
    const { loadConfig } = await import("./core/config/index.js");
    const { resolveBackupSettings } = await import("./core/backup/plan.js");
    const { talonVersion } = await import("./util/version.js");
    const result = await checkpointOnVersionChange({
      settings: resolveBackupSettings(loadConfig().backup),
      version: talonVersion(),
    });
    return { safe: result.status !== "failed" };
  } catch (err) {
    if (err instanceof ConfigFileError) throw err;
    logError("backup", "Pre-upgrade version check failed", err);
    const { raiseAlert } = await import("./core/frontend-runtime/alerts.js");
    raiseAlert(
      "backup.upgrade-checkpoint",
      `The boot-time version check / pre-upgrade checkpoint crashed: ${String(err)}. Booted without it; boot-time cleanup skipped.`,
      { severity: "critical" },
    );
    return { safe: false };
  }
}

const upgrade = await withConfigGuard(() =>
  bootPhase("upgrade checkpoint", checkpointIfUpgraded),
);

const { config } = await withConfigGuard(() =>
  bootPhase("bootstrap", () =>
    bootstrap({ skipDestructiveSteps: !upgrade.safe }),
  ),
);

// Record this process as the daemon. The gateway port is appended once
// the gateway binds (it may fall back from the default on EADDRINUSE).
const bootedAt = new Date().toISOString();
writePidRecord({ pid: process.pid, startedAt: bootedAt });

// ── Create gateway + frontend ─────────────────────────────────────────────────

const gateway = new Gateway("daemon");
// Fail rather than fall back when the gateway port belongs to another
// daemon: a fallback port is how a second daemon went unnoticed.
gateway.setPortInUseCheck(async (port) => {
  const { probeHealth } = await import("./core/daemon/discovery.js");
  const health = await probeHealth(port);
  return health?.app === "talon" &&
    health.mode === "daemon" &&
    health.pid !== process.pid
    ? `gateway port ${port} is held by another Talon daemon (pid ${String(health.pid)})`
    : undefined;
});
gateway.onStarted((port) =>
  writePidRecord({ pid: process.pid, port, startedAt: bootedAt }),
);
gateway.onShutdownRequest((reason) => void gracefulShutdown(reason));

const configuredFrontends = [...new Set(getFrontends(config))];

const frontends: Frontend[] = [];
await bootPhase("frontends create", async () => {
  for (const name of configuredFrontends) {
    const frontend = await createFrontendById(name, config, gateway);
    frontends.push(frontend);
    log("bot", `Frontend: ${getFrontendDescriptor(name)?.label ?? name}`);
  }
});

// ── Create backend + wire dispatcher ─────────────────────────────────────────

const { backend } = await bootPhase("backend + dispatcher", () =>
  initBackendAndDispatcher(config, frontends),
);
gateway.backend = backend;

// Subscribe the gateway to chat-role rebinds so `/model`, `/settings`,
// shared-action dispatch, etc. all see the new backend the moment a
// rebind resolves. Heartbeat / dream / per-chat-override rebinds don't
// touch the gateway field — those roles run from their own getBackend
// providers (dispatcher routes per chat).
const { onBackendChange, roleHolder } =
  await import("./core/engine/backend-controller/index.js");
const CHAT_ROLE_HOLDER = roleHolder("chat");
onBackendChange((holder, newBackend, info) => {
  if (holder !== CHAT_ROLE_HOLDER) return;
  gateway.backend = newBackend;
  log("bot", `Gateway backend reference updated → ${info.label}`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

/**
 * Arm the backup scheduler. Here rather than in bootstrap because this is
 * where the process lifecycle lives — `stopBackupScheduler` is two screens
 * down in `gracefulShutdown`, and the two belong together. Failure
 * notifications go to `backup.notifyChatId` when set, otherwise to the
 * admin, over the same route as the plan alerts.
 */
async function startBackups(): Promise<void> {
  const { initBackup } = await import("./core/backup/index.js");
  const { resolveBackupSettings } = await import("./core/backup/plan.js");
  const notifyChatId = config.backup?.notifyChatId;
  await initBackup({
    settings: resolveBackupSettings(config.backup),
    notify: notifyChatId
      ? async (text: string) => {
          const { resolveFrontendIdAmong } =
            await import("./core/frontend-runtime/routing.js");
          const name = resolveFrontendIdAmong(
            notifyChatId,
            frontends.map((frontend) => frontend.name),
          );
          const target =
            frontends.find((frontend) => frontend.name === name) ??
            frontends[0];
          if (target) await target.sendMessage(Number(notifyChatId), text);
        }
      : undefined,
  });
}

let shuttingDown = false;
let triggerPruneTimer: ReturnType<typeof setInterval> | null = null;

// The composition root owns the SQLite handle, so it hands the crash
// path its checkpoint (see core/daemon/crash.ts).
const crashHooks = { flushDatabase };

const SHUTDOWN_TIMEOUT_MS = 15_000;
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * One best-effort teardown step. A failing subsystem (a frontend that
 * won't stop, a plugin that throws in destroy, a dynamic import that
 * fails mid-shutdown) must not abort the rest of the sequence — the
 * WAL checkpoint and pidfile removal below have to run regardless.
 */
async function shutdownStep(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Even the report is best-effort: a shutdown triggered by a full
    // disk must not die inside its own error path.
    crashStep("shutdown report", () =>
      logError("shutdown", `${name} failed`, err),
    );
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `${signal} received, shutting down gracefully...`);

  const deadlineAt = Date.now() + SHUTDOWN_TIMEOUT_MS;
  const forceTimer = setTimeout(() => {
    // Cleanup first, report second. Handing off matters most here: a
    // restart must survive a subsystem that won't stop (a wedged FUSE
    // unmount, an MCP server ignoring SIGTERM, a backend child that
    // never acks), and it must also survive a logger that can't write —
    // logging first is what cost us the successor on 2026-09-18. The
    // successor may briefly race the long-poll we failed to release,
    // but grammy retries the 409 — a few seconds of overlap beats
    // staying down.
    crashCleanup(crashHooks);
    crashStep("timeout report", () =>
      logError("shutdown", "Timeout exceeded, forcing exit"),
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  // Drain in-flight queries. A turn can legitimately run for minutes, so a
  // drain that only waits can never succeed against one — ask every running
  // turn to abort first, then poll for the aborts to settle so backends can
  // flush partial state before the process exits.
  if (getActiveCount() > 0) {
    const aborted = stopAllTurns();
    log(
      "shutdown",
      `Waiting for ${getActiveCount()} in-flight queries to drain` +
        (aborted > 0 ? ` (abort requested for ${aborted})` : "") +
        `...`,
    );
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (getActiveCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const remaining = getActiveCount();
    if (remaining > 0) {
      logWarn(
        "shutdown",
        `Drain timed out with ${remaining} queries still in flight`,
      );
    }
  }

  // stop() takes the surface down AND awaits the run loop start() left
  // running, so a frontend is provably finished before the stores below
  // are flushed. The force timer above is the backstop for one that
  // won't end.
  await shutdownStep("frontends", () =>
    Promise.allSettled(frontends.map((frontend) => frontend.stop())),
  );
  // Land the router's token ledger before the process goes: writes are
  // debounced, so a clean exit would otherwise drop the last few seconds
  // of spend and start the next boot reading a backend as fresher than it is.
  await shutdownStep("backend ledger", async () => {
    const { flushBackendLedger } =
      await import("./core/engine/backend-router/index.js");
    await flushBackendLedger();
  });
  // Tear down every instantiated backend, including per-chat overrides.
  // Checking only config.backend orphaned an OpenCode child whenever the
  // process default was Claude but one chat had switched to OpenCode.
  await shutdownStep("backend pool", async () => {
    const { cleanupBackendPool } =
      await import("./core/engine/backend-controller/index.js");
    await cleanupBackendPool();
  });
  // Destroy plugins (cleanup resources)
  if (config.plugins.length > 0) {
    await shutdownStep("plugins", async () => {
      const { destroyPlugins } = await import("./core/plugin/index.js");
      await destroyPlugins();
    });
  }
  await shutdownStep("fuse layer", unmountNamespaceFs);
  await shutdownStep("backup scheduler", stopBackupScheduler);
  await shutdownStep("pulse timer", stopPulseTimer);
  await shutdownStep("heartbeat", async () => {
    stopHeartbeatTimer();
    // Cap the wait by what's left of the force-timer budget (minus margin
    // for the steps below). The default 10s wait plus a full 5s drain used
    // to consume the entire 15s budget, so a slow heartbeat tripped the
    // forced exit even though teardown was proceeding normally.
    await awaitHeartbeat(Math.max(0, deadlineAt - Date.now() - 3_000));
  });
  await shutdownStep("cron timer", stopCronTimer);
  await shutdownStep("plan alerts", stopPlanAlerts);
  await shutdownStep("trigger prune timer", () => {
    if (triggerPruneTimer) clearInterval(triggerPruneTimer);
    triggerPruneTimer = null;
  });
  await shutdownStep("triggers", shutdownTriggers);
  // Sub-agents are isolated one-shot runs: aborting them is all the daemon
  // can do, and their parents are gone with the process anyway.
  await shutdownStep("sub-agents", shutdownAgents);
  await shutdownStep("watchdog", stopWatchdog);
  await shutdownStep("resource sampler", stopResourceSampler);
  await shutdownStep("health alerts", stopHealthAlerts);
  await shutdownStep("upload cleanup", stopUploadCleanup);
  await shutdownStep("mcp hub", async () => {
    const { shutdownHub } = await import("./core/mcp-hub/index.js");
    await shutdownHub();
  });
  // Each tail step stands alone: a full disk can make any of them throw,
  // and none of them may cost us the ones that follow.
  crashStep("database flush", () => flushDatabase());
  // Guarded removal: only clear the record if it still names us. A
  // successor that raced ahead and wrote its own pid here must not be
  // orphaned (the bug that made `talon restart` spawn duplicate daemons).
  crashStep("pid record removal", () => removePidRecordIfOwnedBy(process.pid));
  crashStep("shutdown report", () => log("shutdown", "State saved"));
  // Hand off last: the frontends are stopped, so the successor binds
  // Telegram's long-poll only after we have released it. No-op unless
  // /restart or /update armed a respawn.
  crashStep("respawn handoff", () => spawnSuccessor());
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
// /restart and /update come in here directly rather than through a
// self-sent SIGTERM — see core/daemon/respawn.ts.
setRespawnShutdown((reason) => void gracefulShutdown(`respawn (${reason})`));

// Cleanup runs before the crash is reported (and the EPIPE suppression
// is unchanged) — see core/daemon/crash.ts for why the order matters.
process.on("uncaughtException", (err) =>
  handleUncaughtException(err, crashHooks),
);

process.on("unhandledRejection", handleUnhandledRejection);

// ── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Namespace on disk first: symlink farm always, live views (proc/,
  // plugins/) via FUSE when the host can. Bounded and never-throwing —
  // a host without FUSE boots identically, minus live views.
  await mountNamespaceFs({ mode: config.fuse, vfs: getVfs() });

  await Promise.all(frontends.map((frontend) => frontend.init()));
  log("bot", "Starting Talon...");

  await startBackups();
  if (config.pulse) startPulseTimer(config.pulseIntervalMs);
  if (config.heartbeat) startHeartbeatTimer(config.heartbeatIntervalMinutes);
  startWatchdog(config.workspace);
  startUploadCleanup(config.workspace);

  // Cron MUST start before the frontends are awaited: a long-polling
  // frontend's start() blocks for the entire process lifetime, so anything
  // sequenced after that await effectively runs at shutdown. (Regression
  // #396→3.5.0: startCronTimer() sat after the frontend await and no
  // scheduled job fired for 23 days.) Message delivery inside cron uses the
  // frontend's send API, which works as soon as init() has completed —
  // it does not depend on the polling loop being up.
  //
  // Catch-up replays runs that came due while Talon was down (per-job
  // policy; default for new jobs is "once"). Kicking it off first gives it
  // the ~60s head start to take each replayed job's in-flight lock before
  // the first scheduled tick, so a replay can't race a scheduled run.
  // Fire-and-forget so a slow replay never blocks startup.
  runStartupCatchup().catch((err) =>
    logError("cron", "startup catch-up failed", err),
  );
  startCronTimer();

  // Sweep settled triggers (fired/errored/cancelled/timed_out/terminated)
  // past their retention window so the trigger list doesn't accumulate
  // corpses forever. Once at boot, then daily.
  const pruned = pruneSettledTriggers();
  if (pruned > 0) log("triggers", `Pruned ${pruned} settled trigger(s)`);
  triggerPruneTimer = setInterval(
    () => {
      const n = pruneSettledTriggers();
      if (n > 0) log("triggers", `Pruned ${n} settled trigger(s)`);
    },
    24 * 60 * 60_000,
  );
  triggerPruneTimer.unref();

  // Every frontend's start() resolves when it is LISTENING, never when
  // it stops (contract in core/frontend-runtime/capabilities.ts): the
  // long-poll / reconnect loop lives inside the frontend and is awaited
  // by its stop(). So this await ends at the real end of the boot, and
  // what follows runs while the daemon is alive — not, as it once did,
  // hours later during shutdown.
  await bootPhase("frontends start", () => startFrontends(frontends));
  // Phase 0 accounting (docs/ts-migration-plan.md): the boot is over the
  // moment the frontends are listening, so the totals are folded into the
  // metrics store here, from the same uptime figure the log line prints.
  // A restore applied at boot happened before any frontend existed, so the
  // operator hears about it here, on the first channel that can carry it.
  if (restoreReport) {
    const { notifyAdmin } =
      await import("./core/frontend-runtime/admin-notify.js");
    await notifyAdmin(restoreReport);
  }
  // Same reasoning for a crash: the process that died couldn't say so,
  // so the marker it left is announced now. The probes start here too —
  // an alert raised before a frontend can carry it is wasted.
  announceLastCrash();
  startHealthAlerts();

  const bootMs = Math.round(process.uptime() * 1000);
  recordBootMetrics(bootMs);
  startResourceSampler();
  log("bot", `Ready in ${bootReport(bootMs)}`);

  // main() returning is not the process ending: the daemon stays alive on
  // the handles the frontends hold (gateway listener, bridge server,
  // long-poll, readline) until a signal reaches gracefulShutdown().
}

main().catch((err) => {
  crashCleanup(crashHooks);
  crashStep("crash marker", () => writeCrashMarker("startup", err));
  crashStep("startup report", () =>
    logError("bot", "Fatal startup error", err),
  );
  process.exit(1);
});
