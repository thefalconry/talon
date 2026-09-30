import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Silence the logger
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({ recordError: vi.fn() }));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));

const {
  initTriggers,
  spawnTrigger,
  cancelTrigger,
  shutdownTriggers,
  getRunningCount,
  resumeAfterRestart,
} = await import("../core/background/triggers/index.js");

import type { Trigger } from "../storage/triggers.js";

const {
  addTrigger,
  generateTriggerId,
  getTrigger,
  updateTrigger,
  _resetTriggersForTesting,
  DEFAULT_TIMEOUT_SECONDS,
  SHUTDOWN_KILL_ERROR,
} = await import("../storage/triggers.js");

import { writeFileSync, mkdirSync } from "node:fs";

let tmpRoot: string;
let executeSpy: ReturnType<typeof vi.fn>;
const hasUsableBash =
  spawnSync("bash", ["-lc", "exit 0"], {
    stdio: "ignore",
    windowsHide: true,
  }).status === 0;
const describeBash = hasUsableBash ? describe : describe.skip;

function makeTrigger(opts: {
  body: string;
  language?: "bash" | "python" | "node";
  timeoutSeconds?: number;
  ext?: string;
}): Trigger {
  const id = generateTriggerId();
  const language = opts.language ?? "bash";
  const ext =
    opts.ext ??
    (language === "bash" ? "sh" : language === "python" ? "py" : "js");
  const scriptPath = resolve(tmpRoot, `${id}.${ext}`);
  const logPath = resolve(tmpRoot, `${id}.log`);
  writeFileSync(scriptPath, opts.body, { mode: 0o700 });

  const t: Trigger = {
    id,
    chatId: "chat-1",
    numericChatId: 1,
    name: `t-${id.slice(-6)}`,
    language,
    scriptPath,
    logPath,
    status: "pending",
    createdAt: Date.now(),
    timeoutSeconds: opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    fireCount: 0,
  };
  addTrigger(t);
  return t;
}

function waitForStatus(
  id: string,
  predicate: (status: string) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      const t = getTrigger(id);
      if (t && predicate(t.status)) return res();
      if (Date.now() - start > timeoutMs)
        return rej(new Error(`timeout waiting on ${id} (status=${t?.status})`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForRunningCount(target: number, timeoutMs = 5000): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      if (getRunningCount() === target) return res();
      if (Date.now() - start > timeoutMs)
        return rej(
          new Error(
            `timeout waiting for running count ${target} (got ${getRunningCount()})`,
          ),
        );
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** finalizeExit stamps endedAt right before its wake decision, so once it is
 *  set any wake dispatch for that exit has already happened (or been skipped). */
function waitForEnded(id: string, timeoutMs = 5000): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      if (getTrigger(id)?.endedAt !== undefined) return res();
      if (Date.now() - start > timeoutMs)
        return rej(new Error(`timeout waiting for ${id} to finalize`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForExecuteCalls(count: number, timeoutMs = 5000): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      if (executeSpy.mock.calls.length >= count) return res();
      if (Date.now() - start > timeoutMs)
        return rej(
          new Error(
            `timeout waiting for ${count} execute call(s), got ${executeSpy.mock.calls.length}`,
          ),
        );
      setTimeout(tick, 25);
    };
    tick();
  });
}

beforeAll(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "talon-trigger-test-"));
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetTriggersForTesting();
  executeSpy = vi.fn(async () => ({
    text: "ok",
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    bridgeMessageCount: 0,
  }));
  initTriggers({ execute: executeSpy as never });
});

describeBash("trigger supervisor", () => {
  it("fires a wake-up on clean exit 0 with stdout payload", async () => {
    const t = makeTrigger({
      body: 'echo "task done"\nexit 0\n',
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");

    expect(getTrigger(t.id)!.exitCode).toBe(0);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const call = executeSpy.mock.calls[0][0];
    expect(call.source).toBe("trigger");
    expect(call.senderName).toBe("Trigger");
    expect(call.chatId).toBe("chat-1");
    expect(call.prompt).toMatch(/Status: fired/);
    expect(call.prompt).toMatch(/task done/);
  });

  it("fires an error wake-up on non-zero exit", async () => {
    const t = makeTrigger({
      body: 'echo "boom" >&2\nexit 7\n',
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "errored");
    expect(getTrigger(t.id)!.exitCode).toBe(7);

    const call = executeSpy.mock.calls[0][0];
    expect(call.prompt).toMatch(/Status: errored/);
    expect(call.prompt).toMatch(/boom/);
  });

  it("fires mid-run on TALON_FIRE: lines without exiting", async () => {
    // Two TALON_FIRE: lines, then exit 0. We expect 3 fires total: 2 mid-run + 1 terminal.
    const t = makeTrigger({
      body:
        'echo "TALON_FIRE: alpha"\n' +
        'echo "ignored regular line"\n' +
        'echo "TALON_FIRE: beta"\n' +
        "exit 0\n",
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");

    await waitForExecuteCalls(2);
    expect(executeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const prompts = executeSpy.mock.calls.map((c) => c[0].prompt as string);
    expect(prompts.some((p) => p.includes("alpha"))).toBe(true);
    expect(prompts.some((p) => p.includes("beta"))).toBe(true);
    expect(getTrigger(t.id)!.fireCount).toBeGreaterThanOrEqual(2);
  });

  it("cancelTrigger SIGTERMs a running script and marks cancelled", async () => {
    const t = makeTrigger({ body: "sleep 30\n" });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "running");
    expect(getRunningCount()).toBe(1);

    expect(cancelTrigger(t.id)).toBe(true);
    await waitForStatus(t.id, (s) => s === "cancelled");
    // Wait for the SIGTERM to actually take effect and finalizeExit to run
    await waitForRunningCount(0);
  });

  it("hard timeout kills the script and fires a timed_out wake-up", async () => {
    const t = makeTrigger({ body: "sleep 30\n", timeoutSeconds: 1 });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "timed_out", 8000);
    const final = getTrigger(t.id)!;
    expect(final.status).toBe("timed_out");
    expect(final.lastError).toMatch(/Timed out/);
  });

  it("rejects unsupported languages without spawning", () => {
    const t = makeTrigger({ body: "echo hi" });
    // Force an unsupported language post-creation to test the supervisor guard
    (t as { language: string }).language = "ruby";
    spawnTrigger(t);
    expect(getTrigger(t.id)!.status).toBe("errored");
    expect(getTrigger(t.id)!.lastError).toMatch(/Unsupported language/);
  });

  it("shutdownTriggers terminates all running children", async () => {
    const a = makeTrigger({ body: "sleep 30\n" });
    const b = makeTrigger({ body: "sleep 30\n" });
    spawnTrigger(a);
    spawnTrigger(b);
    await waitForStatus(a.id, (s) => s === "running");
    await waitForStatus(b.id, (s) => s === "running");

    await shutdownTriggers();
    await waitForStatus(a.id, (s) => s === "terminated");
    await waitForStatus(b.id, (s) => s === "terminated");
    await waitForRunningCount(0);
    expect(getRunningCount()).toBe(0);

    // The backend pool is torn down alongside the triggers, so the terminal
    // wake must not be dispatched during shutdown — the record is left for
    // resumeAfterRestart to report on the next boot.
    await waitForEnded(a.id);
    await waitForEnded(b.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(getTrigger(a.id)!.lastError).toBe(SHUTDOWN_KILL_ERROR);
    expect(getTrigger(a.id)!.lastFireAt).toBeUndefined();
  });

  it("defers the shutdown death notice of a mid-run watcher to the next boot", async () => {
    // A watcher that signalled mid-run has lastFireAt set. Killing it at
    // shutdown must not dispatch a wake (pool is going away), and the next
    // boot's resumeAfterRestart must still deliver the death notice.
    const t = makeTrigger({ body: 'echo "TALON_FIRE: alive"\nsleep 30\n' });
    spawnTrigger(t);
    await waitForExecuteCalls(1);
    expect(getTrigger(t.id)!.lastFireAt).toBeDefined();

    await shutdownTriggers();
    await waitForEnded(t.id);
    await waitForRunningCount(0);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(getTrigger(t.id)!.status).toBe("terminated");

    // Next boot: initTriggers clears the shutdown flag, resume fires the
    // late notice keyed on SHUTDOWN_KILL_ERROR.
    initTriggers({ execute: executeSpy as never });
    await resumeAfterRestart();
    expect(executeSpy).toHaveBeenCalledTimes(2);
    const call = executeSpy.mock.calls[1][0];
    expect(call.chatId).toBe(t.chatId);
    expect(call.prompt).toMatch(/terminated/);
    expect(call.prompt).toContain(SHUTDOWN_KILL_ERROR);
  });

  it("writes interleaved stdout + stderr to the log file", async () => {
    const t = makeTrigger({
      body: 'echo "from stdout"\necho "from stderr" >&2\nexit 0\n',
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");

    expect(existsSync(t.logPath)).toBe(true);
    const log = readFileSync(t.logPath, "utf-8");
    expect(log).toMatch(/from stdout/);
    expect(log).toMatch(/\[stderr\] from stderr/);
    expect(log).toMatch(/--- spawn/);
    expect(log).toMatch(/--- exit code=0/);
  });

  describe("persistent triggers", () => {
    it("shutdownTriggers parks persistent triggers as 'pending' and does not fire wake", async () => {
      const t = makeTrigger({ body: "sleep 30\n" });
      // getTrigger now returns a fresh copy from SQLite (not a live ref), so
      // mark persistent both on the object spawnTrigger reads and in the DB
      // that finalizeExit/shutdown consult.
      t.persistent = true;
      updateTrigger(t.id, { persistent: true });

      spawnTrigger(t);
      await waitForStatus(t.id, (s) => s === "running");

      await shutdownTriggers();
      // shutdownTriggers sets status=pending immediately; finalizeExit clears
      // pid async when the child actually dies from SIGTERM. Poll for both.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const cur = getTrigger(t.id)!;
        if (cur.status === "pending" && cur.pid === undefined) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const after = getTrigger(t.id)!;
      expect(after.status).toBe("pending");
      expect(after.pid).toBeUndefined();
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("resumeAfterRestart respawns persistent+pending triggers without firing a wake", async () => {
      const t = makeTrigger({
        body: 'echo "back up"\nsleep 30\n',
      });
      updateTrigger(t.id, { persistent: true, status: "pending" });

      const baseline = getRunningCount();
      await resumeAfterRestart();
      await waitForStatus(t.id, (s) => s === "running");
      expect(getRunningCount()).toBe(baseline + 1);
      expect(executeSpy).not.toHaveBeenCalled();

      // Clean up the long-running child so it doesn't bleed into other tests
      await shutdownTriggers();
    });

    it("resumeAfterRestart does NOT respawn non-persistent terminated triggers (only fires wake)", async () => {
      const t = makeTrigger({ body: "echo done\nexit 0\n" });
      updateTrigger(t.id, {
        status: "terminated",
        endedAt: Date.now(),
        lastError: "Talon restarted while trigger was running",
      });

      const baseline = getRunningCount();
      await resumeAfterRestart();
      expect(getRunningCount()).toBe(baseline);
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    // Helper: read starttime from /proc/<pid>/stat (field 22). Linux only.
    const readStarttime = (pid: number): number => {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const last = stat.lastIndexOf(")");
      return Number(stat.slice(last + 2).split(" ")[19]);
    };

    const itLinux = process.platform === "linux" ? it : it.skip;

    itLinux(
      "resumeAfterRestart kills orphan with matching starttime before respawning",
      async () => {
        const { spawn: rawSpawn } = await import("node:child_process");
        const orphanScript = resolve(tmpRoot, "orphan.sh");
        writeFileSync(orphanScript, "while true; do sleep 1; done\n", {
          mode: 0o700,
        });
        const orphan = rawSpawn("bash", [orphanScript], {
          detached: true,
          stdio: "ignore",
        });
        orphan.unref();
        const orphanExited = new Promise<void>((res) =>
          orphan.on("exit", () => res()),
        );
        await new Promise((r) => setTimeout(r, 50));
        const orphanPid = orphan.pid!;
        expect(orphanPid).toBeDefined();

        const t = makeTrigger({ body: "sleep 30\n" });
        updateTrigger(t.id, {
          persistent: true,
          status: "pending",
          pid: orphanPid,
          pidStarttime: readStarttime(orphanPid),
        });

        await resumeAfterRestart();
        await waitForStatus(t.id, (s) => s === "running");
        await Promise.race([
          orphanExited,
          new Promise((r) => setTimeout(r, 2000)),
        ]);

        let alive = true;
        try {
          process.kill(orphanPid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);

        await shutdownTriggers();
      },
    );

    itLinux(
      "leaves a live trigger alone when the daemon that spawned it is still running",
      async () => {
        // Two daemons at once (2026-09-27): the newcomer's resume must not
        // SIGKILL the running daemon's watchers. A sleeping process stands
        // in for that other, live daemon.
        const { spawn: rawSpawn } = await import("node:child_process");
        const owner = rawSpawn("sleep", ["30"], {
          detached: true,
          stdio: "ignore",
        });
        owner.unref();
        await new Promise((r) => setTimeout(r, 50));
        const ownerPid = owner.pid!;
        const watcher = rawSpawn("sleep", ["30"], {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            TALON_DAEMON_PID: String(ownerPid),
            TALON_DAEMON_STARTTIME: String(readStarttime(ownerPid)),
          },
        });
        watcher.unref();
        await new Promise((r) => setTimeout(r, 50));
        const watcherPid = watcher.pid!;

        const t = makeTrigger({ body: "sleep 30\n" });
        updateTrigger(t.id, {
          persistent: true,
          status: "pending",
          pid: watcherPid,
          pidStarttime: readStarttime(watcherPid),
        });

        try {
          await resumeAfterRestart();
          await waitForStatus(t.id, (s) => s === "running");
          expect(() => process.kill(watcherPid, 0)).not.toThrow();
        } finally {
          for (const pid of [watcherPid, ownerPid]) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* gone */
            }
          }
          await shutdownTriggers();
        }
      },
    );

    itLinux(
      "PID-reuse defence: starttime mismatch leaves the live process alone",
      async () => {
        // Simulate the "PID was recycled to an unrelated process" case by
        // recording a deliberately-wrong starttime. killOrphan must NOT
        // kill this process — it's not ours anymore.
        const { spawn: rawSpawn } = await import("node:child_process");
        const innocent = rawSpawn("bash", ["-c", "sleep 30"], {
          detached: true,
          stdio: "ignore",
        });
        innocent.unref();
        await new Promise((r) => setTimeout(r, 50));
        const innocentPid = innocent.pid!;

        const t = makeTrigger({ body: "sleep 30\n" });
        updateTrigger(t.id, {
          persistent: true,
          status: "pending",
          pid: innocentPid,
          pidStarttime: 1, // bogus — guaranteed not to match real starttime
        });

        await resumeAfterRestart();
        await waitForStatus(t.id, (s) => s === "running");

        // Innocent process must still be alive
        let alive = false;
        try {
          process.kill(innocentPid, 0);
          alive = true;
        } catch {
          /* dead — bug */
        }
        expect(alive).toBe(true);

        // Clean up: kill the "innocent" sleeper ourselves
        try {
          process.kill(innocentPid, "SIGKILL");
        } catch {
          /* already gone */
        }
        await shutdownTriggers();
      },
    );

    it("persistent triggers ignore timeout_seconds (no hard kill)", async () => {
      // 1s timeout — non-persistent would die; persistent must keep running.
      const t = makeTrigger({ body: "sleep 5\n", timeoutSeconds: 1 });
      // spawnTrigger reads persistent off the passed object to skip the hard
      // timeout; the store copy must carry it too for exit-path checks.
      t.persistent = true;
      updateTrigger(t.id, { persistent: true });

      spawnTrigger(t);
      await waitForStatus(t.id, (s) => s === "running");

      // Wait past the would-be timeout
      await new Promise((r) => setTimeout(r, 1500));
      expect(getTrigger(t.id)!.status).toBe("running");

      await shutdownTriggers();
    });
  });
});
