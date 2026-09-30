/**
 * Hub child transport — the SDK's stdio client transport with the child
 * process kept in view.
 *
 * `StdioClientTransport` spawns the process itself and hides it: its
 * `onclose` carries no exit code or signal, and stderr is either
 * inherited (lost in the daemon's own stderr, never in talon.log) or
 * piped raw. When a child died during the initialize handshake —
 * playwright-tools with its browser endpoint down, say — the hub saw
 * only "MCP error -32000: Connection closed" and nothing about why.
 *
 * This transport owns the spawn so the hub can record the cause: exit
 * code + signal, and the last few stderr lines in a bounded ring
 * buffer. Wire behaviour matches the SDK transport —
 * newline-delimited JSON-RPC over stdin/stdout; `close()` ends stdin and
 * sends SIGTERM, then SIGKILL after a grace period.
 *
 * It also applies the MCP stdout filter in-process (the rule the
 * per-child supervisor used to apply, shared via parseJsonRpcLine):
 * only lines that are JSON objects reach the MCP client; banners and log
 * lines some servers print on stdout are re-routed into the stderr tail,
 * tagged, instead of surfacing as protocol parse errors. Orphan cleanup
 * is the child guard's job (child-guard.ts), fed by onSpawned/onExited.
 */

import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { parseJsonRpcLine, STDOUT_REROUTE_TAG } from "./launcher.js";

/** How many trailing stderr lines a child keeps for its exit report. */
export const STDERR_TAIL_LINES = 20;
/** Per-line cap so one runaway stack trace can't bloat a log entry. */
const STDERR_LINE_MAX_CHARS = 400;

function clipLine(raw: string): string {
  const line = raw.replace(/\r$/, "");
  return line.length > STDERR_LINE_MAX_CHARS
    ? `${line.slice(0, STDERR_LINE_MAX_CHARS)}…`
    : line;
}

/**
 * Bounded ring buffer over a line stream: keeps the last `capacity`
 * non-blank lines. Chunks may split lines arbitrarily; an unterminated
 * trailing fragment is included in snapshots so a crash mid-line (no
 * final newline before exit) still shows its last words.
 */
export class StderrTail {
  private lines: string[] = [];
  private partial = "";

  constructor(private readonly capacity = STDERR_TAIL_LINES) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim().length === 0) continue;
      this.lines.push(clipLine(line));
    }
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
  }

  snapshot(): string[] {
    const tail = this.partial.trim().length > 0 ? [clipLine(this.partial)] : [];
    return [...this.lines, ...tail].slice(-this.capacity);
  }
}

export type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type HubChildTransportOptions = {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Called with the pid once the process has spawned (orphan guard). */
  onSpawned?: (pid: number) => void;
  /** Called with the pid once the process has exited (orphan guard). */
  onExited?: (pid: number) => void;
};

/**
 * Splits child stdout into lines and applies the MCP stdout filter:
 * JSON-object lines go to `onLine` (already parsed, so each line is
 * parsed once), everything else non-blank to `onReject`. A trailing
 * fragment without a newline is held until more data arrives or
 * `flush()` runs at end of stream.
 */
export class StdoutLineFilter {
  private buf = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly onLine: (parsed: object) => void,
    private readonly onReject: (line: string) => void,
  ) {}

  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let nl;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.emit(line);
    }
  }

  flush(): void {
    const rest = this.buf + this.decoder.end();
    this.buf = "";
    if (rest.length > 0) this.emit(rest);
  }

  private emit(line: string): void {
    const parsed = parseJsonRpcLine(line);
    if (parsed !== null) this.onLine(parsed);
    else if (line.trim().length > 0) this.onReject(line.replace(/\r$/, ""));
  }
}

const CLOSE_GRACE_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export class HubChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child: ChildProcess | null = null;
  /** Kept past exit so the exit report can name the process. */
  private spawnedPid: number | null = null;
  private readonly stderrTail = new StderrTail();
  private readonly stdoutFilter = new StdoutLineFilter(
    (parsed) => this.deliver(parsed),
    // Not protocol: keep it visible where a failure report will look.
    (line) => this.stderrTail.push(`${STDOUT_REROUTE_TAG}${line}\n`),
  );
  private exitInfo: ChildExit | null = null;
  private closeRequested = false;

  constructor(private readonly opts: HubChildTransportOptions) {}

  get pid(): number | null {
    return this.spawnedPid;
  }

  /** Exit code + signal once the process has gone; null while alive. */
  get exit(): ChildExit | null {
    return this.exitInfo;
  }

  /** True when the hub itself asked for the close (reap/retire/shutdown). */
  get closedByHub(): boolean {
    return this.closeRequested;
  }

  /** Last stderr lines seen so far (bounded, see STDERR_TAIL_LINES). */
  get stderrLines(): string[] {
    return this.stderrTail.snapshot();
  }

  start(): Promise<void> {
    if (this.child) {
      return Promise.reject(new Error("HubChildTransport already started"));
    }
    return new Promise((resolve, reject) => {
      const child = crossSpawn(this.opts.command, this.opts.args, {
        env: this.opts.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: process.platform === "win32",
      });
      this.child = child;
      this.spawnedPid = child.pid ?? null;
      const pid = child.pid;
      if (pid !== undefined) this.opts.onSpawned?.(pid);
      child.once("spawn", () => resolve());
      child.on("error", (err) => {
        reject(err);
        this.onerror?.(err);
      });
      // The guard forgets the pid as soon as the process is gone, so a
      // recycled pid is never reaped on the daemon's behalf.
      if (pid !== undefined) {
        child.once("exit", () => this.opts.onExited?.(pid));
      }
      // `close` (not `exit`) so the stderr tail is complete when the
      // exit report is read.
      child.on("close", (code, signal) => {
        this.exitInfo = { code, signal };
        this.child = null;
        this.onclose?.();
      });
      child.stdin?.on("error", (err) => this.onerror?.(err));
      child.stdout?.on("error", (err) => this.onerror?.(err));
      child.stdout?.on("data", (chunk: Buffer) =>
        this.stdoutFilter.push(chunk),
      );
      child.stdout?.on("end", () => this.stdoutFilter.flush());
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => this.stderrTail.push(chunk));
      child.stderr?.on("error", () => {});
    });
  }

  /** Validate one parsed stdout line as JSON-RPC and hand it on. */
  private deliver(parsed: object): void {
    const result = JSONRPCMessageSchema.safeParse(parsed);
    if (result.success) this.onmessage?.(result.data);
    else
      this.onerror?.(
        new Error(`Invalid JSON-RPC message: ${result.error.message}`),
      );
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    const child = this.child;
    this.child = null;
    if (child) {
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const alive = () => child.exitCode === null && child.signalCode === null;
      // EOF and SIGTERM together, SIGKILL after the grace — what the
      // per-child supervisor did when its stdin closed, so a child sees
      // the same shutdown whether or not a supervisor sits in between
      // (with one, it escalates within its own 1s, inside our grace).
      child.stdin?.end();
      if (alive()) child.kill("SIGTERM");
      await Promise.race([closed, delay(CLOSE_GRACE_MS)]);
      if (alive()) child.kill("SIGKILL");
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin) {
        reject(new Error("Not connected"));
        return;
      }
      if (stdin.write(serializeMessage(message))) {
        resolve();
      } else {
        stdin.once("drain", resolve);
      }
    });
  }
}
