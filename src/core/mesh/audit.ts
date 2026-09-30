/**
 * Mesh command audit — one line per device command the daemon dispatched:
 * when, who asked (chat / turn / sender, when a turn issued it), which
 * device, which command, a hash of its arguments, how it ended, and how
 * long it took.
 *
 * Arguments are never written, only `argsHash`: the SHA-256 of their
 * canonical JSON (keys sorted at every depth). Command lines and file
 * bodies stay out of the file, but an operator holding a suspect command
 * can still prove whether it is the one that ran.
 *
 * The log is a bounded ring on disk: JSON lines appended to
 * ~/.talon/data/mesh-audit.jsonl (0600). When the next line would take the
 * file past `maxBytes` it rotates to `mesh-audit.jsonl.1`, replacing the
 * previous generation, so the pair never holds more than about twice the
 * cap. Appends are serialized, so lines never interleave.
 *
 * Recording is fire-and-forget and can never fail a command: every error
 * is caught here and logged (once per failure streak), and the command
 * path carries on.
 */

import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { dirs } from "../../util/paths.js";
import { logWarn } from "../../util/log.js";
import { currentTurn } from "../../util/logging/turn-scope.js";

const DEFAULT_FILE = resolve(dirs.data, "mesh-audit.jsonl");
/** One generation's cap; the file plus its `.1` stay under twice this. */
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_READ_LIMIT = 50;
const MAX_READ_LIMIT = 5_000;
/** Longest failure reason kept (the device's own one-line summary). */
const MAX_ERROR_CHARS = 200;

/** Who issued a command. Present only when a turn issued it. */
export type MeshAuditIssuer = {
  chatId: string;
  turnId: string;
  /** The sender's operator key or display name, when the turn had one. */
  sender?: string;
  /** What started the turn: message, cron, trigger, pulse, agent. */
  source?: string;
};

export type MeshAuditEntry = {
  /** ISO-8601 dispatch time. */
  time: string;
  issuer: MeshAuditIssuer | null;
  deviceId: string;
  deviceName: string;
  command: string;
  /** SHA-256 (hex) of the canonical JSON of the command's params. */
  argsHash: string;
  ok: boolean;
  /** Why it failed (one line, truncated); absent on success. */
  error?: string;
  durationMs: number;
};

export type MeshAuditQuery = {
  /** Newest entries to return (default 50). */
  limit?: number;
  /** Device id (exact) or name (case-insensitive, substring). */
  device?: string;
};

/** Sort object keys at every depth, so equal params hash equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // fromEntries defines own properties, so a `__proto__` key stays data.
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/** SHA-256 (hex) of the canonical JSON of a command's params. */
export function hashCommandArgs(params: unknown): string {
  const json = JSON.stringify(canonical(params ?? {})) ?? "null";
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Who is issuing a command right now: the running turn of the current
 * async chain (tool actions re-enter it through the gateway), or null for
 * a dispatch no turn made (a `/mesh` command, a bridge UI request).
 */
export function auditIssuer(): MeshAuditIssuer | null {
  const turn = currentTurn();
  if (!turn) return null;
  const { sender, source } = turn.issuer;
  return {
    chatId: turn.chatId,
    turnId: turn.turnId,
    ...(sender ? { sender } : {}),
    ...(source ? { source } : {}),
  };
}

/** A device's failure message, kept to one short line. */
export function auditErrorText(message: string | undefined): string {
  const line = (message ?? "failed").split(/\r?\n/, 1)[0]!.trim();
  return line.length > MAX_ERROR_CHARS
    ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…`
    : line || "failed";
}

function matchesDevice(entry: MeshAuditEntry, device: string): boolean {
  const q = device.toLowerCase();
  return (
    entry.deviceId === device ||
    (typeof entry.deviceName === "string" &&
      entry.deviceName.toLowerCase().includes(q))
  );
}

/** Parse JSON lines, skipping any torn or foreign line. */
function parseLines(raw: string): MeshAuditEntry[] {
  const out: MeshAuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as MeshAuditEntry;
      if (entry && typeof entry.command === "string") out.push(entry);
    } catch {
      // A half-written line from a crash mid-append: skip it.
    }
  }
  return out;
}

export class MeshAuditLog {
  private chain: Promise<void> = Promise.resolve();
  /** Bytes in the current generation; null until first checked on disk. */
  private size: number | null = null;
  private failing = false;

  constructor(
    private readonly file: string = DEFAULT_FILE,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {}

  /** Queue one entry. Never throws and never rejects. */
  record(entry: MeshAuditEntry): void {
    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch (err) {
      this.warn(err);
      return;
    }
    this.chain = this.chain
      .then(() => this.append(line))
      .then(() => {
        this.failing = false;
      })
      .catch((err: unknown) => this.warn(err));
  }

  /** Resolves once every queued entry has been written (or given up on). */
  flush(): Promise<void> {
    return this.chain;
  }

  /** The newest matching entries, oldest first. */
  async read(query: MeshAuditQuery = {}): Promise<MeshAuditEntry[]> {
    await this.flush();
    const limit = Math.min(
      MAX_READ_LIMIT,
      Math.max(1, Math.floor(query.limit ?? DEFAULT_READ_LIMIT)),
    );
    const [older, current] = await Promise.all([
      readFile(`${this.file}.1`, "utf8").catch(() => ""),
      readFile(this.file, "utf8").catch(() => ""),
    ]);
    let entries = [...parseLines(older), ...parseLines(current)];
    if (query.device) {
      const device = query.device;
      entries = entries.filter((e) => matchesDevice(e, device));
    }
    return entries.slice(-limit);
  }

  private async append(line: string): Promise<void> {
    if (this.size === null) this.size = await this.open();
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) {
      await rename(this.file, `${this.file}.1`);
      this.size = 0;
    }
    await appendFile(this.file, line, { mode: 0o600 });
    this.size += bytes;
  }

  /** First write this process: make the directory, tighten an old file. */
  private async open(): Promise<number> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    let size: number;
    try {
      size = (await stat(this.file)).size;
    } catch {
      return 0; // no file yet: appendFile creates it 0600
    }
    // A file from an older build or a copied home may be wider than 0600.
    await chmod(this.file, 0o600).catch(() => {});
    return size;
  }

  private warn(err: unknown): void {
    if (this.failing) return;
    this.failing = true;
    logWarn(
      "mesh",
      `mesh.audit event=write_failed file=${this.file} err=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
