/**
 * Functional tests for the hub's MCP child guard (one reaper per daemon,
 * see core/mcp-hub/child-guard.ts). Real processes, no mocks: a harness
 * plays the daemon — it enables the guard, spawns MCP-child stand-ins
 * DIRECTLY (no per-child supervisor) and registers them — and each test
 * kills or disturbs the harness the way production would.
 *
 * The guarantee under test is the one the per-child supervisor gave
 * (mcp-launcher-functional.test.ts): no MCP child outlives Talon, even
 * when Talon is SIGKILLed and the child ignores stdin EOF and SIGTERM.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// POSIX-only: Windows has no signals/mountinfo semantics these tests rely on.
const isWin = process.platform === "win32";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD_MODULE = pathToFileURL(
  resolve(REPO_ROOT, "src/core/mcp-hub/child-guard.ts"),
).href;
const REAPER_MODULE = pathToFileURL(
  resolve(REPO_ROOT, "src/core/mcp-hub/reaper.ts"),
).href;
const TSX_IMPORT = pathToFileURL(
  resolve(REPO_ROOT, "node_modules/tsx/dist/esm/index.mjs"),
).href;
const TIMEOUT_MS = 30_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const leaked: number[] = [];

async function expectAllGone(pids: number[], timeoutMs = 5_000) {
  const gone = await waitFor(() => pids.every((p) => !pidAlive(p)), timeoutMs);
  const stuck = pids.filter(pidAlive);
  leaked.push(...stuck);
  expect(gone, `orphaned pids: ${stuck.join(", ")}`).toBe(true);
}

/** Resolve with the first stdout match of `re`. */
function readMarker(
  proc: ChildProcess,
  re: RegExp,
  label: string,
): Promise<RegExpMatchArray> {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${label}; got: ${buf}`)),
      TIMEOUT_MS - 5_000,
    );
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(re);
      if (m) {
        clearTimeout(timer);
        proc.stdout!.off("data", onData);
        resolvePromise(m);
      }
    };
    proc.stdout!.on("data", onData);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited before ${label} (code=${code})`));
    });
  });
}

/**
 * An MCP-child stand-in that is as hard to kill as possible short of
 * SIGKILL: it ignores stdin EOF, and optionally SIGTERM.
 */
function writeIdler(dir: string, ignoreSigterm: boolean): string {
  const path = join(dir, ignoreSigterm ? "stubborn.mjs" : "idler.mjs");
  writeFileSync(
    path,
    `
    process.on("SIGTERM", () => { ${ignoreSigterm ? "" : "process.exit(0);"} });
    process.stdin.resume();
    process.stdin.on("end", () => { /* ignore EOF on purpose */ });
    setInterval(() => {}, 1 << 30);
    `,
  );
  return path;
}

/**
 * Harness = the daemon. Dispatches `_mcp-reaper` like src/cli.ts does,
 * enables the guard, spawns `count` idlers, guards them (or guards then
 * releases, when `release`), prints `PIDS=<reaper>,<idler>...`.
 * Stdin commands: `kill-reaper` SIGKILLs the reaper; `reaper?` prints
 * `REAPER=<pid>`.
 */
function writeHarness(
  dir: string,
  opts: { count: number; idler: string; release?: boolean },
): string {
  const path = join(dir, "harness.mjs");
  writeFileSync(
    path,
    `
    import { spawn } from "node:child_process";
    import { MCP_REAPER_SUBCOMMAND, runReaper } from ${JSON.stringify(REAPER_MODULE)};
    if (process.argv[2] === MCP_REAPER_SUBCOMMAND) await runReaper();

    const guard = await import(${JSON.stringify(GUARD_MODULE)});
    guard.enableChildGuard();
    const idlers = [];
    for (let i = 0; i < ${opts.count}; i++) {
      const c = spawn(process.execPath, [${JSON.stringify(opts.idler)}], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      guard.guardChild(c.pid);
      ${opts.release ? "guard.releaseChild(c.pid);" : ""}
      idlers.push(c.pid);
    }
    // The pipe write is buffered, so wait until the reaper is running.
    const until = Date.now() + 10000;
    while (guard.reaperPid() === null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 300));
    process.stdout.write("PIDS=" + [guard.reaperPid(), ...idlers].join(",") + "\\n");
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", async (d) => {
      buf += d;
      if (buf.includes("kill-reaper")) {
        buf = "";
        const old = guard.reaperPid();
        process.kill(old, "SIGKILL");
        const t = Date.now() + 10000;
        while ((guard.reaperPid() === null || guard.reaperPid() === old) && Date.now() < t) {
          await new Promise((r) => setTimeout(r, 20));
        }
        await new Promise((r) => setTimeout(r, 300));
        process.stdout.write("REAPER=" + guard.reaperPid() + "\\n");
      }
    });
    setInterval(() => {}, 1 << 30);
    `,
  );
  return path;
}

describe("MCP child guard (reaper)", () => {
  let dir: string;
  let harness: ChildProcess | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "talon-reaper-"));
  });

  afterEach(() => {
    if (harness && harness.exitCode === null) harness.kill("SIGKILL");
    harness = null;
    for (const pid of leaked.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function startHarness(opts: {
    count: number;
    ignoreSigterm?: boolean;
    release?: boolean;
  }): ChildProcess {
    const idler = writeIdler(dir, opts.ignoreSigterm === true);
    const script = writeHarness(dir, { ...opts, idler });
    const proc = spawn(process.execPath, ["--import", TSX_IMPORT, script], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        TALON_HOME: dir,
        TALON_BRIDGE_URL: "",
        TALON_MCP_SUPERVISOR: "",
        // The embedder contract: re-invoke an entry that dispatches.
        TALON_MCP_SUPERVISOR_CMD: JSON.stringify([
          process.execPath,
          "--import",
          TSX_IMPORT,
          script,
        ]),
      },
    });
    harness = proc;
    return proc;
  }

  async function pids(proc: ChildProcess): Promise<number[]> {
    const m = await readMarker(proc, /PIDS=([\d,]+)\n/, "PIDS");
    const list = m[1].split(",").map(Number);
    leaked.push(...list); // cleaned up in afterEach if a test bails early
    return list;
  }

  it(
    "SIGKILL of the daemon reaps every guarded child, then the reaper exits",
    async () => {
      const proc = startHarness({ count: 5 });
      const [reaper, ...idlers] = await pids(proc);
      expect(reaper).toBeGreaterThan(0);
      expect(idlers).toHaveLength(5);
      expect(idlers.every(pidAlive)).toBe(true);

      proc.kill("SIGKILL");
      await expectAllGone([...idlers, reaper]);
    },
    TIMEOUT_MS,
  );

  it.skipIf(isWin)(
    "escalates to SIGKILL for a child that ignores SIGTERM",
    async () => {
      const proc = startHarness({ count: 2, ignoreSigterm: true });
      const [reaper, ...idlers] = await pids(proc);
      const killedAt = Date.now();
      proc.kill("SIGKILL");
      await expectAllGone([...idlers, reaper]);
      // SIGTERM is tried first, so the stubborn ones take ≥ the grace.
      expect(Date.now() - killedAt).toBeGreaterThanOrEqual(900);
    },
    TIMEOUT_MS,
  );

  it.skipIf(isWin)(
    "never signals a released pid (pid-reuse safety)",
    async () => {
      const proc = startHarness({ count: 2, release: true });
      const [reaper, ...idlers] = await pids(proc);
      proc.kill("SIGKILL");
      await expectAllGone([reaper]);
      expect(idlers.every(pidAlive)).toBe(true);
      for (const pid of idlers) process.kill(pid, "SIGKILL");
    },
    TIMEOUT_MS,
  );

  it(
    "a killed reaper is respawned with every live child re-registered",
    async () => {
      const proc = startHarness({ count: 3 });
      const [firstReaper, ...idlers] = await pids(proc);
      proc.stdin!.write("kill-reaper\n");
      const m = await readMarker(proc, /REAPER=(\d+)\n/, "REAPER");
      const secondReaper = Number(m[1]);
      leaked.push(secondReaper);
      expect(secondReaper).not.toBe(firstReaper);
      // The children survived the reaper's death…
      expect(idlers.every(pidAlive)).toBe(true);
      // …and are still guarded by its replacement.
      proc.kill("SIGKILL");
      await expectAllGone([...idlers, secondReaper]);
    },
    TIMEOUT_MS,
  );
});
