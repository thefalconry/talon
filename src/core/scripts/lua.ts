/**
 * Lua trigger runner — executes a trigger script inside a WASM-sandboxed
 * Lua 5.4 VM (wasmoon), speaking the same stdout protocol bash/python/node
 * triggers use (see core/background/triggers/).
 *
 * Why a separate process at all: the trigger supervisor's whole contract
 * (kill/respawn, SIGTERM grace, log streaming, TALON_FIRE line scanning)
 * is built around child processes. Lua therefore runs as `talon _lua-run
 * <script>` — the same self-reinvocation shape MCP supervision uses
 * (core/mcp-hub/launcher.ts) — so it works identically for tsx source runs,
 * npm installs, and bun-compiled binaries with no source tree on disk.
 *
 * Sandbox (verified empirically, not aspirational):
 *   - wasmoon is Lua 5.4 compiled to WASM under emscripten. The VM's
 *     filesystem is MEMFS: `io.open("/etc/hostname")` returns nil, and
 *     `os.getenv` sees only emscripten's stub environment — the host
 *     process env is invisible. No sockets, no subprocesses.
 *   - The full Lua stdlib (string/table/math/os.time/os.clock/io) works
 *     INSIDE the VM; io/os just can't reach the host.
 *   - The only host surface is the injected `talon` API below.
 *
 * Host API (global `talon` table):
 *   talon.fire(text)  — emit `TALON_FIRE: <text>` on stdout (newlines in
 *                       text collapsed to spaces); fires a mid-run wake-up.
 *   talon.log(text)   — stderr line; lands in the trigger run-log as
 *                       `[stderr] …`.
 *   talon.sleep(ms)   — synchronous-looking sleep. Implemented as a JS
 *                       promise the Lua thread suspends on via wasmoon's
 *                       `:await()` (the engine yields the coroutine and
 *                       resumes it when the promise settles).
 *
 * Fire-protocol forgery guard: ALL VM-visible stdout — print(), io.write,
 * io.output():write, anything emscripten emits — funnels through
 * console.log (emscripten's `out` channel). We patch BOTH console.log and
 * process.stdout.write for the run: under node, console.log delegates to
 * the stream's write method, but under bun (compiled binaries) console.log
 * is native and bypasses it entirely — patching only the stream was
 * verified to let a forged print() through in the compiled binary.
 * Everything is line-buffered: any script-originated line starting with
 * `TALON_FIRE:` is escaped with one leading space, which defeats the
 * supervisor's startsWith() check while keeping the text readable in the
 * run-log. Only talon.fire writes through the saved raw stream method, and
 * it terminates any pending partial script line first so a trailing
 * io.write fragment can't glue onto (and break) the protocol line. This is
 * an anti-accident/anti-confusion guard at the stdout choke points —
 * the host sandbox above is what provides actual isolation.
 *
 * Known stdio quirk (verified): `io.write("text")` WITHOUT a trailing
 * newline sits in emscripten's internal TTY buffer and is never flushed —
 * not at chunk end, not at engine close — so it's silently lost, exactly
 * like unflushed C stdio. Scripts should end stdout writes with "\n"
 * (print() always does).
 *
 * Exit codes: 0 — script completed; 1 — Lua error (message + traceback on
 * stderr); 2 — usage error (no script path / unreadable file).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** Hidden CLI subcommand that turns a Talon process into the Lua runner.
 *  Dispatched by src/index.ts and src/cli.ts before the app graph loads. */
export const LUA_RUN_SUBCOMMAND = "_lua-run";

/**
 * Must match FIRE_PREFIX in core/background/triggers/state.ts. Copied,
 * not imported: that module pulls in the dispatcher, and the `_lua-run`
 * helper process must stay light.
 */
const FIRE_PREFIX = "TALON_FIRE:";

/**
 * Run a Lua script file to completion inside a fresh wasmoon engine.
 * Throws on Lua errors (message shaped `<file>:<line>: <msg>` plus
 * traceback). Restores process.stdout.write before returning.
 */
async function runLuaScript(scriptPath: string): Promise<void> {
  const source = readFileSync(scriptPath, "utf-8");

  const originalWrite = process.stdout.write;
  const originalConsoleLog = console.log;
  const rawWrite = originalWrite.bind(process.stdout);

  // ── Line-buffered, fire-escaping stdout for everything the VM emits ──
  let pending = "";
  const emitLine = (line: string): void => {
    rawWrite(line.startsWith(FIRE_PREFIX) ? ` ${line}\n` : `${line}\n`);
  };
  const scriptWrite = (text: string): void => {
    pending += text;
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      emitLine(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
  };
  const flushPending = (): void => {
    if (pending.length === 0) return;
    emitLine(pending);
    pending = "";
  };

  // Both patches MUST be installed before wasmoon is imported: its
  // emscripten glue captures `console.log.bind(console)` at module-eval
  // time. Under node the binding still routes through the stream's write
  // method at call time, but under bun (compiled binaries) console.log is
  // native and a pre-patch binding writes straight to fd 1 — verified to
  // let a forged print() through when the patch came after the import.
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    scriptWrite(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
    );
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  // Emscripten calls console.log with a single already-formatted string
  // per line; joining covers stray multi-arg calls.
  console.log = (...args: unknown[]): void => {
    scriptWrite(`${args.map(String).join(" ")}\n`);
  };

  let lua: import("wasmoon").LuaEngine | undefined;
  try {
    // Lazy import: entrypoints and triggers.ts import this module just for
    // LUA_RUN_SUBCOMMAND — they must not pay for the embedded WASM bundle.
    const { LuaFactory } = await import("wasmoon");
    const factory = new LuaFactory();
    lua = await factory.createEngine();

    // ── Host API ──
    lua.global.set("__talon_fire", (text: unknown) => {
      flushPending();
      const single = String(text)
        .replace(/[\r\n]+/g, " ")
        .trim();
      rawWrite(`${FIRE_PREFIX} ${single}\n`);
    });
    lua.global.set("__talon_log", (text: unknown) => {
      process.stderr.write(`${String(text)}\n`);
    });
    lua.global.set("__talon_sleep", (ms: unknown) => {
      const delay = Math.max(0, Number(ms) || 0);
      return new Promise<void>((resolve) => setTimeout(resolve, delay));
    });

    // The sleep wrapper hides the promise plumbing: scripts just call
    // talon.sleep(ms) and the Lua thread suspends until it resolves.
    await lua.doString(`
      talon = {
        fire = function(text) __talon_fire(tostring(text)) end,
        log = function(text) __talon_log(tostring(text)) end,
        sleep = function(ms) __talon_sleep(ms):await() end,
      }
    `);

    // Mount under the script's basename so Lua errors read
    // `<name>.lua:<line>: <msg>` instead of `[string "…"]`.
    const mounted = `/${basename(scriptPath)}`;
    await factory.mountFile(mounted, source);
    await lua.doFile(mounted);
  } finally {
    // Close the engine BEFORE restoring the patches: if any
    // wasmoon/emscripten teardown ever flushes buffered VM stdout, it must
    // still hit the sanitizer. (Empirically nothing flushes today — see
    // header — but the safe order costs nothing.)
    lua?.global.close();
    console.log = originalConsoleLog;
    process.stdout.write = originalWrite;
    flushPending();
  }
}

/**
 * `_lua-run` entry: run argv[0] as a Lua script and exit with the
 * protocol's exit code. Never resolves — mirrors runSupervisor() so
 * entrypoints can `await` it and nothing after the dispatch ever runs.
 */
export async function runLuaMain(argvTail: string[]): Promise<never> {
  const scriptPath = argvTail[0];
  if (!scriptPath) {
    process.stderr.write("lua-runner: missing script path\n");
    process.exit(2);
  }

  let code = 0;
  try {
    await runLuaScript(scriptPath);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    code = 1;
  }

  // Don't process.exit() straight away: stdout/stderr to a pipe flush
  // asynchronously and an immediate exit can drop the tail of the output
  // (including the final TALON_FIRE line). exitCode is the fallback if a
  // stream never runs its callback.
  process.exitCode = code;
  let remaining = 2;
  const done = (): void => {
    remaining -= 1;
    if (remaining === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
  return new Promise<never>(() => {});
}
